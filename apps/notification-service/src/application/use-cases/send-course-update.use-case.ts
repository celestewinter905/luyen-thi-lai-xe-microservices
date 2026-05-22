import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/notification-client';
import { NotificationRecord } from '../../domain/repositories/notification.repository';
import { NotificationDispatcher } from './notification-dispatcher.service';

export interface SendCourseUpdateInput {
  userId: string;
  email?: string;
  courseId: string;
  courseTitle: string;
  updateSummary: string;
  retryCount?: number;
}

@Injectable()
export class SendCourseUpdateUseCase {
  constructor(private readonly dispatcher: NotificationDispatcher) {}

  async execute(input: SendCourseUpdateInput): Promise<NotificationRecord[]> {
    const channels: NotificationType[] = [
      NotificationType.IN_APP,
      NotificationType.PUSH,
    ];
    if (input.email) channels.push(NotificationType.EMAIL);
    return this.dispatcher.dispatch({
      eventType: 'course.updated',
      userId: input.userId,
      recipientEmail: input.email,
      title: `Cập nhật khóa học: ${input.courseTitle}`,
      body: input.updateSummary,
      data: {
        courseId: input.courseId,
        courseTitle: input.courseTitle,
      },
      channels,
      retryCount: input.retryCount,
    });
  }
}
