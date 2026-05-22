import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/notification-client';
import { NotificationRecord } from '../../domain/repositories/notification.repository';
import { NotificationDispatcher } from './notification-dispatcher.service';

export interface SendExamResultInput {
  eventType: 'exam.session.passed' | 'exam.session.failed';
  userId: string;
  email?: string;
  licenseCategory?: string;
  sessionId?: string;
  score?: number;
  retryCount?: number;
}

@Injectable()
export class SendExamResultUseCase {
  constructor(private readonly dispatcher: NotificationDispatcher) {}

  async execute(input: SendExamResultInput): Promise<NotificationRecord[]> {
    const isPassed = input.eventType === 'exam.session.passed';
    const title = isPassed ? 'Bạn đã vượt qua bài thi' : 'Bài thi chưa đạt';
    const body = isPassed
      ? `Chúc mừng! Bạn đã hoàn thành bài thi ${input.licenseCategory ?? ''}. ${
          typeof input.score === 'number' ? `Điểm: ${input.score}.` : ''
        }`.trim()
      : 'Hãy ôn lại các nhóm câu hỏi thường sai và làm thêm bài luyện đề.';
    const channels: NotificationType[] = [
      NotificationType.IN_APP,
      NotificationType.PUSH,
    ];
    if (input.email) channels.push(NotificationType.EMAIL);
    return this.dispatcher.dispatch({
      eventType: input.eventType,
      userId: input.userId,
      recipientEmail: input.email,
      title,
      body,
      data: {
        sessionId: input.sessionId ?? '',
        licenseCategory: input.licenseCategory ?? '',
        score: input.score ?? null,
        passed: isPassed,
      },
      channels,
      retryCount: input.retryCount,
    });
  }
}
