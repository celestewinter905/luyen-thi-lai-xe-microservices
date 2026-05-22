# Notification Service

Dịch vụ gửi thông báo bất đồng bộ cho nền tảng **Luyện thi lái xe**. Service chịu trách nhiệm: bảng tin in-app, lưu cảnh báo học tập, đăng ký device token cho FCM, và worker fan-out qua SMTP / Push. Mọi đầu vào liên-service đều đi qua RabbitMQ event; tầng HTTP cố tình giữ mỏng — chỉ làm việc đọc trạng thái (`GET /notifications/me`) hoặc đẩy event vào hàng đợi (`POST /admin/academic-warnings`).

Service tuân thủ convention chung được mô tả trong [`CLAUDE.md`](../../CLAUDE.md), [`guides/ddd+clean/CONVENTIONS.md`](../../guides/ddd+clean/CONVENTIONS.md), và plan chi tiết trong [`development-guides-notification-service.md`](./development-guides-notification-service.md). Hợp đồng API công khai nằm tại [`guides/api/api-spec-notification.md`](../../guides/api/api-spec-notification.md).

---

## 1. Kiến trúc tổng quan

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
                                 │   │ (TTL 5 phút) │    │  (IN_APP +     ││
                                 │   └──────────────┘    │   EMAIL + PUSH)││
                                 │                       └──┬─────┬───────┘│
                                 │                          │     │        │
                                 │     ┌────────────────────┘     │        │
                                 │     ▼                          ▼        │
                                 │  Postgres (notifications,   SMTP        │
                                 │  academic_warnings,         (Mailpit /  │
                                 │  device_tokens)             thật)       │
                                 │                          + Firebase FCM │
                                 │                                          │
                                 │  /metrics (Prometheus)                   │
                                 └──────────────────────────────────────────┘
```

Cấu trúc thư mục theo Clean Architecture:

```
src/
├── domain/                        // repository + value contract (không phụ thuộc Nest/Prisma)
│   └── repositories/
│       ├── notification.repository.ts
│       └── device-token.repository.ts
├── application/                   // use case + port
│   ├── ports/
│   │   ├── mail.provider.ts
│   │   ├── push.provider.ts
│   │   └── event-publisher.port.ts
│   └── use-cases/
│       ├── notification-dispatcher.service.ts  // logic fan-out dùng chung
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
│   │   ├── rabbitmq-topology.service.ts        // khai báo queue + DLQ
│   │   ├── retry.publisher.ts                  // publish vào retry queue
│   │   └── notification-event.publisher.ts     // publish event tự phát
│   └── metrics/
│       └── notification.metrics.ts             // counter/gauge của prom-client
└── presentation/
    ├── http/
    │   ├── notification.controller.ts
    │   └── device-token.controller.ts
    ├── messaging/
    │   └── messaging.controller.ts             // các handler @EventPattern qua RMQ
    └── dtos/
        ├── notification.dtos.ts
        └── device-token.dtos.ts
```

---

## 2. Luồng hoạt động khi runtime

### 2.1 Tiêu thụ event kèm retry + DLQ

Khi khởi động, `RabbitMqTopologyService` khai báo sẵn các thành phần sau:

| Thành phần | Mục đích |
| --- | --- |
| Queue `notification_service_events` | Queue chính, mọi service upstream publish vào đây (durable, `noAck=false`). Dead-letter exchange trỏ đến `notification.dlx`. |
| Exchange `notification.retry` (fanout) → Queue `notification_service_retry` | Giữ message retry trong `retry.intervalMs` (mặc định 5 phút). Khi TTL hết, RabbitMQ route message ngược lại `notification_service_events` thông qua `x-dead-letter-routing-key`. |
| Exchange `notification.dlx` (fanout) → Queue `notification_service_dlq` | Nơi “an nghỉ” cuối cùng cho message đã hết số lần retry (`retry.maxAttempts`, mặc định 3). |

`MessagingController` bọc mọi handler bằng helper `runWithRetry()` với luật:

1. Tăng `notification_messages_consumed_total{event_type}`.
2. Gọi handler thật sự.
3. Nếu thành công → `channel.ack(message)`.
4. Nếu lỗi:
   - Khi `retryCount + 1 <= retry.maxAttempts` → ack message gốc và publish envelope mới vào `notification.retry` với `retryCount = retryCount + 1`. Sau khi TTL hết, message tự quay lại queue chính.
   - Khi vượt ngưỡng → `channel.nack(message, false, false)` để route message vào `notification_service_dlq`.

### 2.2 Dispatch tới các kênh

Mỗi use case "send-*" đều ủy quyền cho `NotificationDispatcher.dispatch({ channels, ... })`:

1. Tạo một row `Notification` với `status = QUEUED` cho từng kênh được yêu cầu.
2. Thực thi gửi theo từng kênh:
   - `IN_APP` → đã được persist sẵn, status chuyển thành `DELIVERED` ngay.
   - `EMAIL` → gọi `MailProvider.send(...)` (nodemailer → host SMTP).
   - `PUSH` → lấy toàn bộ `DeviceToken` của user, gọi `PushProvider.sendToTokens(...)`. Token nào bị FCM trả về `messaging/registration-token-not-registered` (hoặc lỗi tương đương) sẽ bị xóa tự động khỏi DB.
3. Khi gửi thành công → cập nhật row thành `DELIVERED` kèm `deliveredAt = now()`, tăng metric success.
4. Khi gửi thất bại → cập nhật `FAILED` kèm `errorMessage`, tăng metric failure, rồi rethrow để tầng messaging xử lý retry.

### 2.3 Luồng cảnh báo học tập (HTTP → event)

```
ADMIN → POST /admin/academic-warnings
       └─► NotificationController publish notification.academic-warning.queued
                                  └─► MessagingController tiêu thụ event đó
                                       └─► SendAcademicWarningUseCase
                                            ├─ tạo row AcademicWarning
                                            └─ dispatch IN_APP + PUSH (+ EMAIL nếu có)
```

HTTP trả về `202 Accepted` ngay, nhờ vậy giao diện admin không bị treo bởi độ trễ SMTP.

---

## 3. Endpoint HTTP

| Method | Path | Role | Ghi chú |
| --- | --- | --- | --- |
| `POST` | `/admin/academic-warnings` | `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR` | Trả về `202 Accepted`. Việc gửi là bất đồng bộ. |
| `GET` | `/notifications/me` | mọi user đã đăng nhập | Liệt kê thông báo của chính mình, mới nhất trước, có phân trang. |
| `PATCH` | `/notifications/:id/read` | mọi user đã đăng nhập | Đánh dấu một thông báo là đã đọc. Quyền sở hữu được kiểm qua JWT `sub`. |
| `POST` | `/notifications/devices` | mọi user đã đăng nhập | Đăng ký / upsert một device token FCM/APNs. |
| `DELETE` | `/notifications/devices/:token` | mọi user đã đăng nhập | Hủy đăng ký device token. |
| `GET` | `/metrics` | nội bộ (không cần auth) | Endpoint cho Prometheus scrape. |
| `GET` | `/docs` / `/docs-json` | nội bộ | Swagger UI (cũng có thể truy cập qua Kong tại `/notification-service/docs`). |

Mô tả chi tiết request/response nằm trong [`guides/api/api-spec-notification.md`](../../guides/api/api-spec-notification.md).

---

## 4. Event

### Event được tiêu thụ (`notification_service_events`)

| Event | Payload (field chính) | Kênh kích hoạt |
| --- | --- | --- |
| `identity.user.created` | `userId`, `email`, `fullName?` | IN_APP, EMAIL |
| `identity.user.password-reset-requested` | `userId`, `email`, `resetUrl` | EMAIL |
| `exam.session.passed` | `studentId`/`userId`, `email?`, `sessionId?`, `licenseCategory?`, `score?` | IN_APP, PUSH (+ EMAIL nếu có `email`) |
| `exam.session.failed` | giống như trên | giống như trên |
| `notification.academic-warning.queued` | `studentId`, `reason`, `severity`, `message`, `createdById`, `studentEmail?` | IN_APP, PUSH (+ EMAIL nếu có `studentEmail`) |
| `course.updated` | `recipientId`, `recipientEmail?`, `courseId`, `courseTitle`, `updateSummary` | IN_APP, PUSH (+ EMAIL nếu có `recipientEmail`) |

Tất cả các event này đều cho phép kèm field `retryCount` (do retry publisher set khi replay).

### Event được phát hành

| Event | Khi nào trigger | Queue đích |
| --- | --- | --- |
| `notification.academic-warning.queued` | `POST /admin/academic-warnings` | `notification_service_events` (chính service này) |

Khi muốn publish event mới từ service khác, đặt `queue` trong ClientsModule là `notification_service_events` và emit đúng pattern. Ví dụ trong identity-service:

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

## 5. Cấu hình (Consul KV)

Toàn bộ config do `ConsulConfigFactory` của `@repo/common` nạp. Các key nằm dưới `config/<env>/notification-service/`. Phần seed thực tế ở [`docker/consul/init.sh`](../../docker/consul/init.sh).

| Key | Mặc định | Ghi chú |
| --- | --- | --- |
| `port` | `3000` (docker) / `3006` (local) | Cổng HTTP |
| `database.url` | `postgresql://user:password@db-notification:5432/notification_db` | Connection string Postgres |
| `rabbitmq.url` | `amqp://rabbitmq:5672` / `amqp://localhost:5672` | RabbitMQ |
| `keycloak.authServerUrl` / `realm` / `clientId` / `clientSecret` | `${KEYCLOAK_CLIENT_SECRET}` | Auth |
| `smtp.host` | `mailpit` (docker) / `localhost` (local) | Có thể override qua `NOTIFICATION_SMTP_HOST` / `NOTIFICATION_SMTP_HOST_LOCAL` |
| `smtp.port` | `1025` | Cổng SMTP của Mailpit |
| `smtp.user` / `smtp.pass` | rỗng | Chỉ cần khi dùng provider SMTP thật |
| `smtp.from` | `no-reply@luyen-thi-lai-xe.local` | Địa chỉ envelope sender |
| `push.fcmCredentials` | rỗng | JSON service account của Firebase. Khi rỗng, push được log và bỏ qua. |
| `retry.maxAttempts` | `3` | Số lần retry tối đa |
| `retry.intervalMs` | `300000` (5 phút) | TTL của retry queue |

### Seed nhanh từ root

```bash
# Stack Docker
NOTIFICATION_SMTP_HOST=mailpit NOTIFICATION_RETRY_INTERVAL_MS=60000 \
NOTIFICATION_FCM_CREDENTIALS="$(cat firebase-service-account.json)" \
npm run consul:seed

# Hybrid dev (service chạy host + infra trong Docker)
npm run consul:seed:local
```

---

## 6. Chạy local

```bash
# 1) Khởi động infra (Postgres, RabbitMQ, Consul, Mailpit, Keycloak, Kong, Redis)
npm run infra:up

# 2) Seed Consul cho môi trường development-local
npm run consul:seed:local

# 3) Áp migration
npm --workspace=apps/notification-service run prisma:generate
npm --workspace=apps/notification-service run db:migrate -- --name local

# 4) Chạy service
npm --workspace=apps/notification-service run start:dev
# → đang lắng nghe tại http://localhost:3006
# → Swagger:  http://localhost:3006/docs
# → Metrics:  http://localhost:3006/metrics
# → Mailpit:  http://localhost:8025
```

URL hữu ích:

| Mục đích | URL |
| --- | --- |
| Swagger | http://localhost:3006/docs |
| Mailpit (email đã bắt) | http://localhost:8025 |
| RabbitMQ UI | http://localhost:15672 (`guest`/`guest`) |
| Consul UI | http://localhost:8500 |
| Prometheus metrics | http://localhost:3006/metrics |

---

## 7. Database

Các model (xem [`prisma/schema.prisma`](./prisma/schema.prisma)):

- `Notification` — mỗi row tương ứng một kênh đã/đang gửi. `status` theo dõi trạng thái gửi, `eventType` gắn lại với event nguồn. Index theo `(userId, isRead, createdAt)` và `(userId, status)`.
- `AcademicWarning` — bản ghi audit do `SendAcademicWarningUseCase` tạo ra.
- `DeviceToken` — mỗi row một device token; `token` là unique; token bị FCM báo invalid sẽ bị tự xóa.

Enum:

- `NotificationType`: `IN_APP`, `EMAIL`, `PUSH`, `SMS`.
- `NotificationStatus`: `PENDING`, `QUEUED`, `DELIVERED`, `FAILED`.

Lệnh migration (chạy từ root repo):

```bash
npm --workspace=apps/notification-service run prisma:generate
npm --workspace=apps/notification-service run db:migrate    # local
npm --workspace=apps/notification-service run db:deploy     # docker / CI
```

---

## 8. Quan sát (observability)

Service expose metric Prometheus tại `/metrics`:

| Metric | Kiểu | Label |
| --- | --- | --- |
| `notification_messages_consumed_total` | counter | `event_type` |
| `notification_delivery_success_total` | counter | `channel`, `event_type` |
| `notification_delivery_failed_total` | counter | `channel`, `event_type` |
| `notification_dlq_depth` | gauge | – |

Log đi qua logger chung của `@repo/common`. Một số dòng log đáng chú ý:

- `RabbitMQ topology sẵn sàng: …` khi khởi động
- `Đã sẵn sàng kết nối SMTP (host=… port=…)`
- `Firebase Admin đã khởi tạo cho việc gửi push FCM` (hoặc warning nếu `push.fcmCredentials` rỗng)
- `Đã đặt lịch retry lần #N cho <event>` mỗi khi publish envelope retry
- `Dừng xử lý <event> sau N lần retry: …; chuyển sang DLQ` khi vượt ngưỡng

---

## 9. Lưu ý vận hành

- **Topology bền giữa các lần restart.** Queue, exchange và DLQ được khai báo lại mỗi lần khởi động với cùng option; RabbitMQ giữ nguyên cái đã tồn tại. Muốn đổi `retry.intervalMs`, phải xóa retry queue trước (hoặc đặt tên khác) — vì TTL là argument của queue và không thể sửa tại chỗ.
- **Kiểm tra DLQ.** Vào RabbitMQ UI ([http://localhost:15672](http://localhost:15672)) để xem message trong `notification_service_dlq`. Sau khi fix nguyên nhân gốc, có thể publish ngược lại `notification_service_events` để xử lý tiếp.
- **Email chỉ ở Mailpit khi dev.** Khi `smtp.host` trỏ về Mailpit, không có email thật nào rời máy. UI tại `http://localhost:8025` hiển thị đầy đủ traffic SMTP.
- **FCM không có credential.** Khi `push.fcmCredentials` rỗng (mặc định), FCM provider chỉ log cảnh báo và short-circuit; không gửi gì cả. Điều này cố ý để dev environment không cần secret Firebase mới chạy được.
- **Endpoint cảnh báo bất đồng bộ.** `POST /admin/academic-warnings` trả về 202 ngay lập tức. Muốn xác nhận đã gửi tới học viên, check `GET /notifications/me` của học viên đó hoặc xem log của worker.

---

## 10. Checklist trước khi merge

```bash
npm --workspace=apps/notification-service run prisma:generate
npm --workspace=apps/notification-service run check-types
npm --workspace=apps/notification-service run build
npx turbo run check-types
docker compose config --quiet
```

Nếu sửa endpoint, DTO, hoặc key Consul, cập nhật thêm [`guides/api/api-spec-notification.md`](../../guides/api/api-spec-notification.md) và [`guides/consul/WORKFLOW.md`](../../guides/consul/WORKFLOW.md).
