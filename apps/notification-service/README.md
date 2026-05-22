# Notification Service

Asynchronous notification dispatcher for the **Luyện thi lái xe** platform. It owns the in-app notification feed, the academic warning record, the FCM device-token registry, and the SMTP / Push fan-out workers. All cross-service inputs arrive as RabbitMQ events; HTTP endpoints are intentionally thin and either read state (`GET /notifications/me`) or enqueue events (`POST /admin/academic-warnings`).

This service follows the monorepo conventions documented in [`CLAUDE.md`](../../CLAUDE.md), [`guides/ddd+clean/CONVENTIONS.md`](../../guides/ddd+clean/CONVENTIONS.md), and the detailed plan in [`development-guides-notification-service.md`](./development-guides-notification-service.md). The public API contract is in [`guides/api/api-spec-notification.md`](../../guides/api/api-spec-notification.md).

---

## 1. Architecture

```
                                 ┌──────────────────────────────────────────┐
                                 │              notification-service        │
                                 │                                          │
 identity-service ─┐             │  ┌───────────────┐    ┌────────────────┐│
 exam-service     ─┼─ RabbitMQ ─►│  │  Messaging    │──►│  Use Cases     ││
 course-service   ─┘             │  │  Controller   │    │  (welcome,     ││
                                 │  │  (retry +     │    │  exam-result,  ││
 HTTP (Kong) ─────────────────► │  │   metrics)    │    │  warning, …)   ││
                                 │  └───────┬───────┘    └──────┬─────────┘│
                                 │          │ retry             │          │
                                 │   ┌──────▼───────┐    ┌──────▼─────────┐│
                                 │   │ Retry Pub.   │    │ Dispatcher     ││
                                 │   │ (TTL 5 min)  │    │  (IN_APP +     ││
                                 │   └──────────────┘    │   EMAIL + PUSH)││
                                 │                       └──┬─────┬───────┘│
                                 │                          │     │        │
                                 │     ┌────────────────────┘     │        │
                                 │     ▼                          ▼        │
                                 │  Postgres (notifications,   SMTP        │
                                 │  academic_warnings,         (Mailpit /  │
                                 │  device_tokens)             real)       │
                                 │                          + Firebase FCM │
                                 │                                          │
                                 │  /metrics (Prometheus)                   │
                                 └──────────────────────────────────────────┘
```

Layout (Clean Architecture):

```
src/
├── domain/                        // repositories, value contracts (no Nest/Prisma)
│   └── repositories/
│       ├── notification.repository.ts
│       └── device-token.repository.ts
├── application/                   // use cases + ports
│   ├── ports/
│   │   ├── mail.provider.ts
│   │   ├── push.provider.ts
│   │   └── event-publisher.port.ts
│   └── use-cases/
│       ├── notification-dispatcher.service.ts  // shared fan-out logic
│       ├── send-welcome-email.use-case.ts
│       ├── send-exam-result.use-case.ts
│       ├── send-academic-warning.use-case.ts
│       ├── send-password-reset.use-case.ts
│       ├── send-course-update.use-case.ts
│       ├── register-device-token.use-case.ts
│       ├── unregister-device-token.use-case.ts
│       └── notification.use-cases.ts           // list / mark read
├── infrastructure/
│   ├── persistence/prisma/
│   │   ├── prisma.service.ts
│   │   ├── prisma-notification.repository.ts
│   │   └── prisma-device-token.repository.ts
│   ├── providers/
│   │   ├── smtp.provider.ts                    // Nodemailer
│   │   └── fcm-push.provider.ts                // firebase-admin
│   ├── messaging/
│   │   ├── rabbitmq.constants.ts
│   │   ├── rabbitmq-topology.service.ts        // declares queues + DLQ
│   │   ├── retry.publisher.ts                  // republish to retry queue
│   │   └── notification-event.publisher.ts     // publish events
│   └── metrics/
│       └── notification.metrics.ts             // prom-client counters/gauges
└── presentation/
    ├── http/
    │   ├── notification.controller.ts
    │   └── device-token.controller.ts
    ├── messaging/
    │   └── messaging.controller.ts             // RMQ @EventPattern handlers
    └── dtos/
        ├── notification.dtos.ts
        └── device-token.dtos.ts
```

---

## 2. Runtime Flow

### 2.1 Event consumption with retry-and-DLQ

The topology service declares the following at boot:

| Component | Purpose |
| --- | --- |
| Queue `notification_service_events` | Main queue all upstream services publish to (durable, `noAck=false`). Dead-letter exchange points to `notification.dlx`. |
| Exchange `notification.retry` (fanout) → Queue `notification_service_retry` | Holds retry envelopes for `retry.intervalMs` (default 5 min). When the TTL expires, RabbitMQ routes the message back to `notification_service_events` via the queue's `x-dead-letter-routing-key`. |
| Exchange `notification.dlx` (fanout) → Queue `notification_service_dlq` | Final resting place for messages that exhausted `retry.maxAttempts` (default 3). |

`MessagingController` wraps every handler in `runWithRetry()`:

1. Increment `notification_messages_consumed_total{event_type}`.
2. Invoke the handler.
3. On success → `channel.ack(message)`.
4. On error:
   - If `retryCount + 1 <= retry.maxAttempts` → ack the original message and publish a new envelope to `notification.retry` with `retryCount = retryCount + 1`. The message reappears in the main queue after the TTL.
   - Else → `channel.nack(message, false, false)` which dead-letters the message to `notification_service_dlq`.

### 2.2 Delivery dispatch

Every "send-*" use case delegates to `NotificationDispatcher.dispatch({ channels, ... })`:

1. Create a `Notification` row with `status = QUEUED` for each requested channel.
2. Run channel-specific delivery:
   - `IN_APP` → already persisted; status flips to `DELIVERED`.
   - `EMAIL` → `MailProvider.send(...)` (nodemailer → SMTP host).
   - `PUSH` → fetch all `DeviceToken`s for the user, call `PushProvider.sendToTokens(...)`. Tokens that FCM rejects as `messaging/registration-token-not-registered` (or similar) are deleted automatically.
3. On success → update the row to `DELIVERED` with `deliveredAt = now()`, bump the success metric.
4. On failure → update to `FAILED` with `errorMessage`, bump the failure metric, rethrow so the messaging layer can retry.

### 2.3 Academic warning HTTP → event flow

```
ADMIN → POST /admin/academic-warnings
       └─► NotificationController publishes notification.academic-warning.queued
                                  └─► MessagingController consumes it
                                       └─► SendAcademicWarningUseCase
                                            ├─ creates AcademicWarning row
                                            └─ dispatches IN_APP + PUSH (+ EMAIL)
```

HTTP responds with `202 Accepted` immediately so the admin UI is not blocked by SMTP latency.

---

## 3. Endpoints

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `POST` | `/admin/academic-warnings` | `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR` | Returns `202 Accepted`. Delivery is asynchronous. |
| `GET` | `/notifications/me` | any authenticated user | Paginated list of own notifications. Newest first. |
| `PATCH` | `/notifications/:id/read` | any authenticated user | Mark a single notification as read. Ownership enforced via JWT `sub`. |
| `POST` | `/notifications/devices` | any authenticated user | Register/upsert an FCM/APNs device token. |
| `DELETE` | `/notifications/devices/:token` | any authenticated user | Unregister a device token. |
| `GET` | `/metrics` | internal (no auth) | Prometheus scrape endpoint. |
| `GET` | `/docs` / `/docs-json` | internal | Swagger UI (also reachable as `/notification-service/docs` through Kong). |

Full request/response schemas are in [`guides/api/api-spec-notification.md`](../../guides/api/api-spec-notification.md).

---

## 4. Events

### Consumed (`notification_service_events`)

| Event | Payload (key fields) | Resulting channels |
| --- | --- | --- |
| `identity.user.created` | `userId`, `email`, `fullName?` | IN_APP, EMAIL |
| `identity.user.password-reset-requested` | `userId`, `email`, `resetUrl` | EMAIL |
| `exam.session.passed` | `studentId`/`userId`, `email?`, `sessionId?`, `licenseCategory?`, `score?` | IN_APP, PUSH (+ EMAIL if `email` present) |
| `exam.session.failed` | same as above | same as above |
| `notification.academic-warning.queued` | `studentId`, `reason`, `severity`, `message`, `createdById`, `studentEmail?` | IN_APP, PUSH (+ EMAIL if `studentEmail` present) |
| `course.updated` | `recipientId`, `recipientEmail?`, `courseId`, `courseTitle`, `updateSummary` | IN_APP, PUSH (+ EMAIL if `recipientEmail` present) |

All consumed events accept an optional `retryCount` field which is set by the retry publisher when a message is replayed.

### Published

| Event | Trigger | Target queue |
| --- | --- | --- |
| `notification.academic-warning.queued` | `POST /admin/academic-warnings` | `notification_service_events` (self) |

To publish a new event from another service, set the client's queue to `notification_service_events` and emit the matching pattern. Example (identity-service):

```ts
ClientsModule.register([
  {
    name: 'NOTI_SERVICE_CLIENT',
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL],
      queue: 'notification_service_events',
      queueOptions: { durable: true },
    },
  },
]);

client.emit('identity.user.created', { userId, email, fullName });
```

---

## 5. Configuration (Consul KV)

All config is loaded by `@repo/common`'s `ConsulConfigFactory`. Keys live under `config/<env>/notification-service/`. The seeding lives in [`docker/consul/init.sh`](../../docker/consul/init.sh).

| Key | Default | Notes |
| --- | --- | --- |
| `port` | `3000` (docker) / `3006` (local) | HTTP port |
| `database.url` | `postgresql://user:password@db-notification:5432/notification_db` | Postgres connection string |
| `rabbitmq.url` | `amqp://rabbitmq:5672` / `amqp://localhost:5672` | RabbitMQ |
| `keycloak.authServerUrl` / `realm` / `clientId` / `clientSecret` | `${KEYCLOAK_CLIENT_SECRET}` | Auth |
| `smtp.host` | `mailpit` (docker) / `localhost` (local) | Override with `NOTIFICATION_SMTP_HOST` / `NOTIFICATION_SMTP_HOST_LOCAL` |
| `smtp.port` | `1025` | Mailpit SMTP |
| `smtp.user` / `smtp.pass` | empty | Required only when pointing at a real provider |
| `smtp.from` | `no-reply@luyen-thi-lai-xe.local` | Envelope sender |
| `push.fcmCredentials` | empty | JSON-serialized Firebase service account. When empty, push is logged and skipped. |
| `retry.maxAttempts` | `3` | Stop retrying after this many attempts |
| `retry.intervalMs` | `300000` (5 min) | Retry queue TTL |

### Quick seeding from root

```bash
# Docker stack
NOTIFICATION_SMTP_HOST=mailpit NOTIFICATION_RETRY_INTERVAL_MS=60000 \
NOTIFICATION_FCM_CREDENTIALS="$(cat firebase-service-account.json)" \
npm run consul:seed

# Hybrid dev (host services + Docker infra)
npm run consul:seed:local
```

---

## 6. Local Development

```bash
# 1) Start infra (Postgres, RabbitMQ, Consul, Mailpit, Keycloak, Kong, Redis)
npm run infra:up

# 2) Seed Consul with development-local config
npm run consul:seed:local

# 3) Apply migrations
npm --workspace=apps/notification-service run prisma:generate
npm --workspace=apps/notification-service run db:migrate -- --name local

# 4) Run the service
npm --workspace=apps/notification-service run start:dev
# → listening on http://localhost:3006
# → Swagger:  http://localhost:3006/docs
# → Metrics:  http://localhost:3006/metrics
# → Mailpit:  http://localhost:8025
```

Useful URLs:

| What | URL |
| --- | --- |
| Swagger | http://localhost:3006/docs |
| Mailpit (caught emails) | http://localhost:8025 |
| RabbitMQ UI | http://localhost:15672 (`guest`/`guest`) |
| Consul UI | http://localhost:8500 |
| Prometheus metrics | http://localhost:3006/metrics |

---

## 7. Database

Models (see [`prisma/schema.prisma`](./prisma/schema.prisma)):

- `Notification` — one row per delivered channel. `status` tracks delivery, `eventType` ties it back to the originating event. Indexed by `(userId, isRead, createdAt)` and `(userId, status)`.
- `AcademicWarning` — audit record created by the SendAcademicWarning use case.
- `DeviceToken` — one row per device token; `token` is unique; tokens that FCM declares invalid are pruned automatically.

Enums:

- `NotificationType`: `IN_APP`, `EMAIL`, `PUSH`, `SMS`.
- `NotificationStatus`: `PENDING`, `QUEUED`, `DELIVERED`, `FAILED`.

Migration commands (run from repo root):

```bash
npm --workspace=apps/notification-service run prisma:generate
npm --workspace=apps/notification-service run db:migrate    # local
npm --workspace=apps/notification-service run db:deploy     # docker / CI
```

---

## 8. Observability

The service exposes Prometheus metrics at `/metrics`:

| Metric | Type | Labels |
| --- | --- | --- |
| `notification_messages_consumed_total` | counter | `event_type` |
| `notification_delivery_success_total` | counter | `channel`, `event_type` |
| `notification_delivery_failed_total` | counter | `channel`, `event_type` |
| `notification_dlq_depth` | gauge | – |

Logs are routed through the shared `@repo/common` Nest logger. Important log lines:

- `RabbitMQ topology ready: …` on boot
- `SMTP transporter ready (host=… port=…)`
- `Firebase Admin initialized for FCM push delivery` (or a warning if `push.fcmCredentials` is empty)
- `Scheduled retry #N for <event>` for every retry envelope published
- `Giving up on <event> after N retries: …; routing to DLQ`

---

## 9. Operational Notes

- **Topology survives restarts.** Queues, exchanges, and DLQ are asserted on every boot with the same options; RabbitMQ keeps existing ones. To change `retry.intervalMs`, delete the retry queue first (or rename it) — TTL is a queue argument and cannot be modified in place.
- **DLQ inspection.** Use the RabbitMQ UI ([http://localhost:15672](http://localhost:15672)) to peek at messages in `notification_service_dlq`. Re-publish them to `notification_service_events` after fixing the underlying cause if needed.
- **Mailpit-only emails in dev.** When `smtp.host` points at Mailpit, no real email leaves the host. The browser UI at `http://localhost:8025` shows the entire SMTP traffic.
- **FCM without credentials.** If `push.fcmCredentials` is empty (default), the FCM provider logs a warning and short-circuits; nothing is sent. This is intentional so dev environments boot without Firebase secrets.
- **Async warning endpoint.** `POST /admin/academic-warnings` returns 202 immediately. To verify delivery, look at `GET /notifications/me` for the student or watch the worker logs.

---

## 10. Checklist Before Merging

```bash
npm --workspace=apps/notification-service run prisma:generate
npm --workspace=apps/notification-service run check-types
npm --workspace=apps/notification-service run build
npx turbo run check-types
docker compose config --quiet
```

If you change endpoints, DTOs, or Consul keys, also update [`guides/api/api-spec-notification.md`](../../guides/api/api-spec-notification.md) and [`guides/consul/WORKFLOW.md`](../../guides/consul/WORKFLOW.md).
