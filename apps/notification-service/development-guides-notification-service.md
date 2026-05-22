Kế hoạch triển khai Notification Service
Tài liệu này phác thảo kế hoạch chi tiết để xây dựng và phát triển notification-service trong hệ thống microservices. Dịch vụ này xử lý thông báo bất đồng bộ qua RabbitMQ (không dùng WebSocket hay SSE), hỗ trợ gửi Email (SMTP/Mailpit) và Push Notification (FCM/APNs), quản lý lịch sử thông báo, và tích hợp Consul cho cấu hình tập trung.

Nguyên tắc Thiết kế & Kiến trúc Chung
Hệ thống sử dụng mô hình DDD (Domain-Driven Design) + Clean Architecture với các quy tắc sau:

Database-per-service (Tách biệt Database):
notification-service sở hữu database riêng notification_db (PostgreSQL, Port: 5437).
Không thực hiện JOIN bảng chéo hoặc tạo Foreign Keys với các database của service khác (như user_db). Chỉ lưu tham chiếu thông tin qua UUID (ví dụ: recipientId / userId).
Giao tiếp bất đồng bộ qua Message Broker (RabbitMQ):
Các service khác (như identity-service, exam-service,...) khi có sự kiện cần gửi thông báo sẽ không gọi API HTTP của notification-service trực tiếp.
Thay vào đó, họ sẽ publish event vào RabbitMQ và trả về phản hồi HTTP 202 Accepted ngay lập tức để không làm nghẽn luồng xử lý chính.
notification-service sẽ làm nhiệm vụ consume event và gửi thông báo độc lập.
Clean Architecture Layering:
domain/: Định nghĩa các aggregate, entity, value object và repository interfaces. Không chứa thư viện ngoài hoặc framework (như NestJS, Prisma).
application/: Chứa các Use Cases nghiệp vụ (ví dụ: gửi cảnh báo học tập, gửi mail welcome) điều phối dữ liệu qua Repository interface.
infrastructure/: Implement thực tế các interface (Prisma repository, Nodemailer SMTP provider, FCM Push provider).
presentation/: HTTP Controller (REST APIs cho Admin/Client tra cứu, đánh dấu đã đọc) và Messaging Controller (lắng nghe event từ RabbitMQ).
Cấu hình tập trung (Consul KV):
Đọc toàn bộ cấu hình từ Consul (Namespace: notification-service/). Không hardcode hoặc dùng trực tiếp .env trong code production.
1. Thiết lập RabbitMQ (Infrastructure)
Cần cấu hình các Exchange, Queue và Dead Letter Queue (DLQ) để xử lý tin nhắn bền bỉ, an toàn:

Queue chính: notification_service_events
Durable: true (Tin nhắn không bị mất khi RabbitMQ restart).
Explicit ACK (noAck: false): Service phải chủ động xác nhận đã xử lý thành công tin nhắn bằng channel.ack(message).
Cấu hình x-dead-letter-exchange trỏ về exchange của DLQ.
Queue chờ (Retry/Delay Queue): notification_service_retry
Dùng để giữ tin nhắn chờ 5 phút trước khi thử lại.
Cấu hình x-message-ttl: 300000 (5 phút).
Cấu hình x-dead-letter-exchange trỏ ngược lại queue notification_service_events.
Dead Letter Queue (DLQ): notification_service_dlq
Nhận tin nhắn lỗi hoàn toàn (sau 3 lần retry).
Exchange (Topic/Fanout):
Cần tạo các exchange để các service khác publish vào (ví dụ identity_service_publish, exam_service_publish). Sau đó bind (liên kết) các exchange này với queue notification_service_events để nhận event.
2. Xây dựng Cấu trúc Mã nguồn notification-service
Cấu trúc thư mục chuẩn theo Clean Architecture sẽ như sau:

text

apps/notification-service/src/
  domain/
    repositories/
      notification.repository.ts
  application/
    ports/
      mail.provider.ts           ← Interface gửi email
      push.provider.ts           ← Interface gửi push
    use-cases/
      send-welcome-email.use-case.ts
      send-exam-result.use-case.ts
      send-academic-warning.use-case.ts
      send-password-reset.use-case.ts
      send-course-update.use-case.ts
  infrastructure/
    persistence/
      prisma/
        prisma-notification.repository.ts
        prisma.service.ts
    providers/
      smtp.provider.ts           ← Cài đặt Nodemailer
      push.provider.ts           ← Cài đặt Firebase Admin SDK
  presentation/
    http/
      notification.controller.ts  ← HTTP endpoints (list, read)
    messaging/
      messaging.controller.ts     ← RabbitMQ Event Consumer
    dtos/
      notification.dtos.ts
  app.module.ts
  main.ts
2.1 Cập nhật Prisma Schema (prisma/schema.prisma)
Cập nhật schema để quản lý trạng thái của bản ghi gửi thông báo (NotificationRecord) và lưu trữ Token thiết bị của học sinh để gửi Push notification (DeviceToken).

prisma

enum NotificationStatus {
  PENDING
  QUEUED
  DELIVERED
  FAILED
}
enum NotificationChannel {
  EMAIL
  PUSH
  IN_APP
}
model NotificationRecord {
  id           String             @id @default(uuid())
  eventType    String
  recipientId  String             // UUID của học viên/giáo viên (cross-service, không có FK)
  channel      NotificationChannel
  title        String
  body         String
  payload      Json               @default("{}") // Payload gốc của event
  status       NotificationStatus @default(PENDING)
  retryCount   Int                @default(0)
  errorMessage String?            @db.Text
  createdAt    DateTime           @default(now())
  deliveredAt  DateTime?
  updatedAt    DateTime           @updatedAt
  @@index([recipientId, status])
  @@map("notification_records")
}
model DeviceToken {
  id          String   @id @default(uuid())
  userId      String   // UUID của user
  token       String   @unique
  platform    String   // 'ios' | 'android'
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([userId])
  @@map("device_tokens")
}
2.2 Xây dựng Consumer & Retry Logic (Cập nhật chuẩn xác)
Dùng @nestjs/microservices với Transport.RMQ.
Đoạn xử lý tin nhắn trong messaging.controller.ts:
Lấy channel và message từ RmqContext.
Gọi UseCase tương ứng. Nếu thành công -> channel.ack(originalMessage).
Nếu gặp lỗi (Retry Logic):
Đọc số lần đã retry từ payload hoặc DB.
Nếu số lần retry < max-attempts (3 lần): Service sẽ ACK tin nhắn hiện tại (để xóa khỏi queue chính), đồng thời publish một tin nhắn mới (bản sao, có tăng retryCount) vào notification_service_retry queue. Tin nhắn này sẽ nằm chờ 5 phút cho đến khi TTL hết hạn, RabbitMQ sẽ tự động đẩy nó quay lại notification_service_events.
Nếu >= max-attempts: Thực hiện channel.nack(originalMessage, false, false) để tin nhắn bị từ chối và tự động trôi vào Dead Letter Queue (DLQ).
3. SMTP & Push Notification Providers
3.1 SMTP Provider (smtp.provider.ts)
Sử dụng thư viện nodemailer.
Trong môi trường phát triển (development / development-local): Kết nối với Mailpit (chạy trên port SMTP: 1025, Web UI: 8025). Mailpit tự động hứng tất cả email gửi đi mà không cần tài khoản thực.
Trong môi trường production: Đọc cấu hình kết nối SMTP thực tế từ Consul KV (notification-service/smtp/host, /port, /user, /pass).
3.2 Push Notification Provider (push.provider.ts)
Sử dụng Firebase Admin SDK (cho Android/iOS qua FCM).
Tạo API lưu token: Học sinh khi đăng nhập ứng dụng React Native sẽ gửi deviceToken lên hệ thống -> được lưu vào bảng DeviceToken.
Khi cần gửi Push: Query danh sách các deviceToken của học sinh đó từ DB -> Dùng messaging().sendEachForMulticast() gửi đồng loạt.
Xử lý dọn dẹp token: Nếu Firebase trả về lỗi token không hợp lệ (ví dụ messaging/registration-token-not-registered) -> tiến hành xóa token đó khỏi bảng DeviceToken.
4. Cấu hình Consul KV & Metrics
4.1 Cấu hình Consul KV
Cần khai báo các biến môi trường cấu hình trong Consul (sửa file seed local và script init của Docker):

notification-service/smtp/host: Mail server host (dev: localhost / docker: mailpit).
notification-service/smtp/port: Cổng gửi mail (dev/docker: 1025).
notification-service/smtp/user: Tài khoản SMTP.
notification-service/smtp/pass: Mật khẩu SMTP.
notification-service/push/fcm-credentials: JSON chứa credentials của Firebase Service Account.
notification-service/retry/max-attempts: Mặc định là 3.
notification-service/retry/interval-ms: Khoảng thời gian giãn cách giữa các lần retry (mặc định 5 phút = 300000).
4.2 Prometheus Metrics Expose
Tích hợp thư viện @willsoto/nestjs-prometheus và prom-client để mở endpoint /metrics:

notification_messages_consumed_total: Đếm số lượng tin nhắn đã nhận từ RabbitMQ (phân loại theo eventType).
notification_delivery_success_total: Số thông báo gửi thành công (chia theo kênh smtp / push).
notification_delivery_failed_total: Số thông báo gửi thất bại.
notification_dlq_depth: Độ sâu của hàng đợi DLQ (Gauge).
5. API / Publishers & Chuyển đổi Bất đồng bộ
Identity Service: Sẽ publish identity.user.created vào một Exchange thay vì queue trực tiếp, để cả user-service và notification-service đều có thể subscribe.
Academic Warning API: API POST /admin/academic-warnings hiện tại đang ghi đồng bộ vào database. Sẽ được sửa đổi để chỉ publish event vào RabbitMQ (hoặc lưu status PENDING) và trả về HTTP 202 Accepted ngay lập tức, nhường việc gửi thông báo cho Consumer.
Kế hoạch Xác minh & Kiểm thử (Verification Plan)
Kiểm thử Tự động (Automated Tests)
Unit Tests:
Kiểm tra logic của từng UseCase độc lập với DB và network (mock repositories và providers).
Kiểm tra logic Retry (Verify số lần tăng và kiểm tra điều kiện chuyển trạng thái sang FAILED).
Integration Tests:
Chạy môi trường Docker infra, publish một mock event (như exam.result.ready) lên RabbitMQ.
Verify:
Consumer trong notification-service nhận được event.
Tạo bản ghi trong database với trạng thái DELIVERED.
Email được hứng thành công trong Mailpit API (gọi http://localhost:8025/api/v1/messages).
Kiểm thử Thủ công (Manual Verification)
Mở Mailpit UI tại http://localhost:8025 để kiểm tra định dạng email (Template, Tiêu đề, Nội dung) gửi từ hệ thống local.
Kiểm tra log từ docker-compose để đảm bảo không có cảnh báo rò rỉ token hoặc lỗi kết nối tới RabbitMQ/Consul.
