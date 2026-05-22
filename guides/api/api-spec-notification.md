# Notification Service API Specification

**Base URL qua Kong:** `http://localhost:8000`  
**Service paths:** `/notifications`, `/admin/academic-warnings`  
**Direct local:** `http://localhost:3006`  
**Swagger UI:** `http://localhost:3006/docs`  
**Swagger UI qua Kong:** `http://localhost:8000/notification-service/docs`  
**OpenAPI JSON:** `http://localhost:3006/docs-json`  
**OpenAPI JSON qua Kong:** `http://localhost:8000/notification-service/docs-json`  
**Version:** 1.0.0

Notification-service lưu thông báo in-app, cảnh báo học tập, và device token cho push. Frontend gọi các API được bảo vệ bằng `Authorization: Bearer <access_token>`; id của người dùng hiện tại được đọc từ JWT `sub`. Không gửi `x-user-id`.

Việc gửi thông báo là **bất đồng bộ**. Tầng HTTP chỉ publish event RabbitMQ; messaging consumer fan-out qua các kênh đã cấu hình (IN_APP, EMAIL qua SMTP/Mailpit, PUSH qua FCM). Một retry queue có TTL sẽ replay các lần gửi thất bại; sau khi vượt số lần retry tối đa, message sẽ được route vào DLQ của notification.

---

## Authentication

| Endpoint | Role |
| --- | --- |
| `POST /admin/academic-warnings` | `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR` |
| `GET /notifications/me` | `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`, `STUDENT` |
| `PATCH /notifications/:id/read` | `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`, `STUDENT` |
| `POST /notifications/devices` | mọi user đã đăng nhập |
| `DELETE /notifications/devices/:token` | mọi user đã đăng nhập |

---

## Response Format

Mọi response thành công đều được bọc bởi `ApiResponseInterceptor`:

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

Response lỗi:

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

| HTTP | Code | Nguyên nhân |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | Body/query/path không hợp lệ |
| 401 | `UNAUTHORIZED` | Thiếu hoặc sai access token |
| 403 | `FORBIDDEN` | Token hợp lệ nhưng role không được phép |
| 404 | `NOT_FOUND` | Notification không tồn tại hoặc không thuộc về người gọi |
| 500 | `INTERNAL_ERROR` | Lỗi database hoặc lỗi khi xử lý event |

---

## Enums

`NotificationType`: `IN_APP` | `EMAIL` | `PUSH` | `SMS`

`NotificationStatus`: `PENDING` | `QUEUED` | `DELIVERED` | `FAILED`

Hiện tại dispatcher sinh các kênh `IN_APP`, `EMAIL`, `PUSH`. `SMS` được giữ chỗ cho kênh gửi mở rộng trong tương lai.

---

## Shared Schemas

### `Notification`

| Field | Type | Mô tả |
| --- | --- | --- |
| `id` | `uuid` | ID thông báo |
| `userId` | `uuid` | ID người nhận |
| `type` | `NotificationType` | Kênh gửi (`IN_APP`, `EMAIL`, `PUSH`, `SMS`) |
| `eventType` | `string | null` | Tên event nguồn, ví dụ `identity.user.created` |
| `title` | `string` | Tiêu đề thông báo |
| `body` | `string` | Nội dung thông báo |
| `data` | `object` | Metadata bổ sung, ví dụ id cảnh báo hoặc id phiên thi |
| `status` | `NotificationStatus` | `PENDING`, `QUEUED`, `DELIVERED`, hoặc `FAILED` |
| `retryCount` | `number` | Số lần đã retry |
| `errorMessage` | `string | null` | Lỗi gửi gần nhất (nếu có) |
| `isRead` | `boolean` | Người nhận đã đọc hay chưa |
| `readAt` | `string | null` | Thời điểm đọc |
| `sentAt` | `string | null` | Thời điểm bắt đầu gửi |
| `deliveredAt` | `string | null` | Thời điểm xác nhận đã gửi thành công |
| `createdAt` | `string` | Thời điểm tạo |
| `updatedAt` | `string` | Thời điểm cập nhật gần nhất |

### `ListNotificationsResponse`

```json
{
  "items": [
    {
      "id": "0b9cb629-4f43-4f4f-a936-7dc664a7351e",
      "userId": "89ea9a17-1cce-4fff-855c-d32a081648cd",
      "type": "IN_APP",
      "title": "Cảnh báo học tập: HIGH",
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

Đưa một cảnh báo học tập của học viên vào hàng đợi. Service sẽ publish event `notification.academic-warning.queued` vào RabbitMQ; worker lưu cảnh báo, tạo thông báo in-app, và gửi email/push nếu học viên đã có cấu hình tương ứng. `createdById` được lấy từ JWT `sub` của người gọi.

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

| Field | Bắt buộc | Quy tắc |
| --- | --- | --- |
| `studentId` | có | UUID |
| `reason` | có | chuỗi không rỗng |
| `severity` | có | chuỗi không rỗng, khuyến nghị dùng `LOW`, `MEDIUM`, `HIGH` |
| `message` | có | chuỗi không rỗng |

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
    "message": "Cảnh báo học tập đã được đưa vào hàng đợi; học viên sẽ nhận thông báo bất đồng bộ."
  }
}
```

**Lỗi thường gặp:** `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL_ERROR`.

---

### GET `/notifications/me`

Trả về danh sách thông báo của người dùng hiện tại, mới nhất trước.

**Auth:** `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`, `STUDENT`

**Query Parameters**

| Tên | Type | Bắt buộc | Mặc định | Quy tắc |
| --- | --- | --- | --- | --- |
| `page` | `number` | không | `1` | Tối thiểu 1 |
| `size` | `number` | không | `20` | Tối thiểu 1, tối đa 100 |

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
        "title": "Bạn đã vượt qua bài thi",
        "body": "Chúc mừng! Bạn đã hoàn thành bài thi mô phỏng.",
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

**Lỗi thường gặp:** `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL_ERROR`.

---

### PATCH `/notifications/:id/read`

Đánh dấu một thông báo là đã đọc. Service kiểm tra quyền sở hữu qua JWT `sub` của người gọi; user không thể đánh dấu giúp thông báo của user khác.

**Auth:** `ADMIN`, `CENTER_MANAGER`, `INSTRUCTOR`, `STUDENT`

**Path Parameters**

| Tên | Type | Bắt buộc | Mô tả |
| --- | --- | --- | --- |
| `id` | `uuid` | có | ID thông báo |

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
    "title": "Cảnh báo học tập: HIGH",
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

**Lỗi thường gặp:** `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INTERNAL_ERROR`.

---

## Device Token Endpoints

### POST `/notifications/devices`

Đăng ký mới hoặc làm tươi (refresh) device token FCM/APNs cho người gọi. Nếu token đã tồn tại, record được upsert thay vì tạo mới.

**Body**

```json
{ "token": "<fcm-device-token>", "platform": "android" }
```

**Response `201`** trả về record đã được lưu.

### DELETE `/notifications/devices/:token`

Hủy đăng ký một device token. Trả về `204 No Content`. Token cũng được tự động xóa khi FCM báo về là không hợp lệ.

---

## Events Consumed

Notification-service bind vào queue `notification_service_events` và tiêu thụ:

| Event | Trigger | Kênh |
| --- | --- | --- |
| `identity.user.created` | Identity-service sau khi tạo account mới | IN_APP + EMAIL (welcome) |
| `identity.user.password-reset-requested` | Identity-service khi user yêu cầu reset mật khẩu | EMAIL |
| `exam.session.passed` | Exam-service khi học viên vượt qua phiên thi | IN_APP + PUSH (+ EMAIL nếu có) |
| `exam.session.failed` | Exam-service khi học viên không đạt phiên thi | IN_APP + PUSH (+ EMAIL nếu có) |
| `notification.academic-warning.queued` | Do `POST /admin/academic-warnings` tự publish | IN_APP + PUSH (+ EMAIL nếu có) |
| `course.updated` | Course-service khi khóa học được publish/cập nhật | IN_APP + PUSH (+ EMAIL nếu có) |

Mỗi lần gửi thất bại sẽ được republish vào `notification_service_retry` (TTL = `retry.intervalMs`); sau `retry.maxAttempts` lần retry, message sẽ bị dead-letter sang `notification_service_dlq`.

Chi tiết về kiến trúc, flow, key Consul, metric Prometheus, và mẹo chạy local: [`apps/notification-service/README.md`](../../apps/notification-service/README.md).
