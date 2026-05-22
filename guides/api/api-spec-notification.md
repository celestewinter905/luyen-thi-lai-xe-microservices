# Notification Service API Specification

**Base URL qua Kong:** `http://localhost:8000`  
**Service paths:** `/notifications`, `/admin/academic-warnings`  
**Direct local:** `http://localhost:3006`  
**Swagger UI:** `http://localhost:3006/docs`  
**Swagger UI qua Kong:** `http://localhost:8000/notification-service/docs`  
**OpenAPI JSON:** `http://localhost:3006/docs-json`  
**OpenAPI JSON qua Kong:** `http://localhost:8000/notification-service/docs-json`  
**Version:** 1.0.0

Notification-service stores in-app notifications, academic warnings, and device tokens. Frontend calls protected APIs with `Authorization: Bearer <access_token>`; current user id is read from JWT `sub`. Do not send `x-user-id`.

Notification delivery is asynchronous. HTTP endpoints publish RabbitMQ events; the messaging consumer fans them out to the configured channels (IN_APP, EMAIL via SMTP/Mailpit, PUSH via FCM). A retry queue with TTL replays failed deliveries; after the configured max attempts the message is routed to the notification DLQ.

---

## Authentication

| Endpoint | Role |
| --- | --- |
| `POST /admin/academic-warnings` | `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR` |
| `GET /notifications/me` | `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`, `STUDENT` |
| `PATCH /notifications/:id/read` | `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`, `STUDENT` |
| `POST /notifications/devices` | any authenticated user |
| `DELETE /notifications/devices/:token` | any authenticated user |

---

## Response Format

All successful responses are wrapped by the global `ApiResponseInterceptor`.

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "OK",
  "timestamp": "2026-05-21T10:00:00.000Z",
  "path": "/notifications/me",
  "data": {}
}
```

Error responses:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "Validation failed",
  "timestamp": "2026-05-21T10:00:00.000Z",
  "path": "/admin/academic-warnings"
}
```

---

## Error Codes

| HTTP | Code | Cause |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid body/query/path parameter |
| 401 | `UNAUTHORIZED` | Missing or invalid access token |
| 403 | `FORBIDDEN` | Token is valid but role is not allowed |
| 404 | `NOT_FOUND` | Notification does not exist or does not belong to caller |
| 500 | `INTERNAL_ERROR` | Database/event handling error |

---

## Enums

`NotificationType`: `IN_APP` | `EMAIL` | `PUSH` | `SMS`

`NotificationStatus`: `PENDING` | `QUEUED` | `DELIVERED` | `FAILED`

`IN_APP`, `EMAIL`, and `PUSH` are produced by the dispatcher today. `SMS` is reserved for future delivery channels.

---

## Shared Schemas

### `Notification`

| Field | Type | Description |
| --- | --- | --- |
| `id` | `uuid` | Notification id |
| `userId` | `uuid` | Recipient user id |
| `type` | `NotificationType` | Delivery channel (`IN_APP`, `EMAIL`, `PUSH`, `SMS`) |
| `eventType` | `string | null` | Source event name, for example `identity.user.created` |
| `title` | `string` | Short notification title |
| `body` | `string` | Notification message |
| `data` | `object` | Extra metadata, for example warning id or exam session id |
| `status` | `NotificationStatus` | `PENDING`, `QUEUED`, `DELIVERED`, or `FAILED` |
| `retryCount` | `number` | Number of retries attempted so far |
| `errorMessage` | `string | null` | Last delivery error if any |
| `isRead` | `boolean` | Whether current recipient has read it |
| `readAt` | `string | null` | Read timestamp |
| `sentAt` | `string | null` | Delivery timestamp |
| `deliveredAt` | `string | null` | Confirmed delivery timestamp |
| `createdAt` | `string` | Creation timestamp |
| `updatedAt` | `string` | Last update timestamp |

### `ListNotificationsResponse`

```json
{
  "items": [
    {
      "id": "0b9cb629-4f43-4f4f-a936-7dc664a7351e",
      "userId": "89ea9a17-1cce-4fff-855c-d32a081648cd",
      "type": "IN_APP",
      "title": "Academic warning: HIGH",
      "body": "Bạn cần ôn lại nhóm câu hỏi thường sai trước khi thi tiếp.",
      "data": {
        "warningId": "48c7047d-3db9-4dc0-bb75-b68735ab51ea",
        "reason": "LOW_EXAM_SCORE",
        "severity": "HIGH"
      },
      "isRead": false,
      "readAt": null,
      "sentAt": "2026-05-21T10:00:00.000Z",
      "createdAt": "2026-05-21T10:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "size": 20
}
```

---

## Endpoints

### POST `/admin/academic-warnings`

Queues an academic warning for a student. The service publishes a `notification.academic-warning.queued` event to RabbitMQ; the worker persists the warning, creates the in-app notification, and sends an email/push if the student has them configured. `createdById` is taken from the caller JWT `sub`.

**Auth:** `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`

**Headers**

```http
Authorization: Bearer <admin_or_instructor_access_token>
```

**Body**

```json
{
  "studentId": "89ea9a17-1cce-4fff-855c-d32a081648cd",
  "reason": "LOW_EXAM_SCORE",
  "severity": "HIGH",
  "message": "Bạn cần ôn lại nhóm câu hỏi thường sai trước khi thi tiếp."
}
```

**Validation**

| Field | Required | Rule |
| --- | --- | --- |
| `studentId` | yes | UUID |
| `reason` | yes | non-empty string |
| `severity` | yes | non-empty string, recommended values: `LOW`, `MEDIUM`, `HIGH` |
| `message` | yes | non-empty string |

**Response `202 Accepted`**

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "OK",
  "timestamp": "2026-05-21T10:00:00.000Z",
  "path": "/admin/academic-warnings",
  "data": {
    "status": "ACCEPTED",
    "message": "Academic warning queued; the student will be notified asynchronously."
  }
}
```

**Common errors:** `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL_ERROR`.

---

### GET `/notifications/me`

Returns the current user's notifications in newest-first order.

**Auth:** `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`, `STUDENT`

**Query Parameters**

| Name | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `page` | `number` | no | `1` | Minimum 1 |
| `size` | `number` | no | `20` | Minimum 1, maximum 100 |

**Response `200`**

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "OK",
  "timestamp": "2026-05-21T10:00:00.000Z",
  "path": "/notifications/me?page=1&size=20",
  "data": {
    "items": [
      {
        "id": "0b9cb629-4f43-4f4f-a936-7dc664a7351e",
        "userId": "89ea9a17-1cce-4fff-855c-d32a081648cd",
        "type": "IN_APP",
        "title": "Exam completed",
        "body": "Bạn đã hoàn thành bài thi mô phỏng.",
        "data": {
          "sessionId": "7976cf6d-5aab-4a6d-bd34-3e97bdade9cd"
        },
        "isRead": false,
        "readAt": null,
        "sentAt": "2026-05-21T10:00:00.000Z",
        "createdAt": "2026-05-21T10:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "size": 20
  }
}
```

**Common errors:** `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL_ERROR`.

---

### PATCH `/notifications/:id/read`

Marks one notification as read. The service checks ownership with the caller JWT `sub`; users cannot mark another user's notification.

**Auth:** `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`, `STUDENT`

**Path Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `uuid` | yes | Notification id |

**Response `200`**

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "OK",
  "timestamp": "2026-05-21T10:00:00.000Z",
  "path": "/notifications/0b9cb629-4f43-4f4f-a936-7dc664a7351e/read",
  "data": {
    "id": "0b9cb629-4f43-4f4f-a936-7dc664a7351e",
    "userId": "89ea9a17-1cce-4fff-855c-d32a081648cd",
    "type": "IN_APP",
    "title": "Academic warning: HIGH",
    "body": "Bạn cần ôn lại nhóm câu hỏi thường sai trước khi thi tiếp.",
    "data": {
      "warningId": "48c7047d-3db9-4dc0-bb75-b68735ab51ea",
      "reason": "LOW_EXAM_SCORE",
      "severity": "HIGH"
    },
    "isRead": true,
    "readAt": "2026-05-21T10:03:00.000Z",
    "sentAt": "2026-05-21T10:00:00.000Z",
    "createdAt": "2026-05-21T10:00:00.000Z"
  }
}
```

**Common errors:** `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INTERNAL_ERROR`.

---

## Device Token Endpoints

### POST `/notifications/devices`

Registers or refreshes an FCM/APNs device token for the caller. The same token is upserted if it already exists.

**Body**

```json
{ "token": "<fcm-device-token>", "platform": "android" }
```

**Response `201`** returns the persisted record.

### DELETE `/notifications/devices/:token`

Unregisters a device token. Returns `204 No Content`. Tokens are also pruned automatically when FCM reports them as invalid.

---

## Events Consumed

Notification-service binds to `notification_service_events` and consumes:

| Event | Trigger | Channels |
| --- | --- | --- |
| `identity.user.created` | Identity-service after a new account is created | IN_APP + EMAIL (welcome) |
| `identity.user.password-reset-requested` | Identity-service when a password reset is requested | EMAIL |
| `exam.session.passed` | Exam-service when a student passes a session | IN_APP + PUSH (+ EMAIL if available) |
| `exam.session.failed` | Exam-service when a student fails a session | IN_APP + PUSH (+ EMAIL if available) |
| `notification.academic-warning.queued` | Self-published by `POST /admin/academic-warnings` | IN_APP + PUSH (+ EMAIL if available) |
| `course.updated` | Course-service when a course is published/updated | IN_APP + PUSH (+ EMAIL if available) |

Each failed delivery is republished to `notification_service_retry` (TTL = `retry.intervalMs`); after `retry.maxAttempts` retries the message is dead-lettered to `notification_service_dlq`.

For architecture, flow, Consul keys, Prometheus metrics, and local-dev tips, see [`apps/notification-service/README.md`](../../apps/notification-service/README.md).
