import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/notification-client';
import { NotificationRecord } from '../../domain/repositories/notification.repository';
import { NotificationDispatcher } from './notification-dispatcher.service';

export interface SendWelcomeEmailInput {
  userId: string;
  email: string;
  fullName?: string;
  retryCount?: number;
}

@Injectable()
export class SendWelcomeEmailUseCase {
  constructor(private readonly dispatcher: NotificationDispatcher) {}

  async execute(input: SendWelcomeEmailInput): Promise<NotificationRecord[]> {
    const greeting = input.fullName
      ? `Xin chào ${input.fullName},`
      : 'Xin chào,';
    const body =
      `${greeting}\n\n` +
      'Chúc mừng bạn đã tham gia hệ thống Luyện thi lái xe. ' +
      'Bạn có thể bắt đầu các khóa học và làm bài luyện đề ngay bây giờ.';
    return this.dispatcher.dispatch({
      eventType: 'identity.user.created',
      userId: input.userId,
      recipientEmail: input.email,
      title: 'Chào mừng đến với Luyện thi lái xe',
      body,
      data: { email: input.email },
      channels: [NotificationType.IN_APP, NotificationType.EMAIL],
      retryCount: input.retryCount,
    });
  }
}
