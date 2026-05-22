import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/notification-client';
import { NotificationRecord } from '../../domain/repositories/notification.repository';
import { NotificationDispatcher } from './notification-dispatcher.service';

export interface SendPasswordResetInput {
  userId: string;
  email: string;
  resetUrl: string;
  retryCount?: number;
}

@Injectable()
export class SendPasswordResetUseCase {
  constructor(private readonly dispatcher: NotificationDispatcher) {}

  async execute(input: SendPasswordResetInput): Promise<NotificationRecord[]> {
    const body =
      'Bạn (hoặc ai đó) đã yêu cầu đặt lại mật khẩu cho tài khoản này. ' +
      `Truy cập liên kết sau để tiếp tục: ${input.resetUrl}\n\n` +
      'Nếu không phải bạn, vui lòng bỏ qua email này.';
    return this.dispatcher.dispatch({
      eventType: 'identity.user.password-reset-requested',
      userId: input.userId,
      recipientEmail: input.email,
      title: 'Yêu cầu đặt lại mật khẩu',
      body,
      data: { resetUrl: input.resetUrl },
      channels: [NotificationType.EMAIL],
      retryCount: input.retryCount,
    });
  }
}
