import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/notification-client';
import {
  AcademicWarningRecord,
  NotificationRecord,
  NotificationRepository,
} from '../../domain/repositories/notification.repository';
import { NotificationDispatcher } from './notification-dispatcher.service';

export interface SendAcademicWarningInput {
  studentId: string;
  reason: string;
  severity: string;
  message: string;
  createdById: string;
  studentEmail?: string;
  warningId?: string;
  retryCount?: number;
}

@Injectable()
export class SendAcademicWarningUseCase {
  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly repository: NotificationRepository,
  ) {}

  async execute(input: SendAcademicWarningInput): Promise<{
    warning: AcademicWarningRecord;
    notifications: NotificationRecord[];
  }> {
    const warning: AcademicWarningRecord = input.warningId
      ? {
          id: input.warningId,
          studentId: input.studentId,
          reason: input.reason,
          severity: input.severity,
          message: input.message,
          createdById: input.createdById,
          createdAt: new Date(),
        }
      : await this.repository.createAcademicWarning({
          studentId: input.studentId,
          reason: input.reason,
          severity: input.severity,
          message: input.message,
          createdById: input.createdById,
        });

    const channels: NotificationType[] = [
      NotificationType.IN_APP,
      NotificationType.PUSH,
    ];
    if (input.studentEmail) channels.push(NotificationType.EMAIL);

    const notifications = await this.dispatcher.dispatch({
      eventType: 'notification.academic-warning.created',
      userId: input.studentId,
      recipientEmail: input.studentEmail,
      title: `Cảnh báo học tập: ${input.severity}`,
      body: input.message,
      data: {
        warningId: warning.id,
        reason: input.reason,
        severity: input.severity,
      },
      channels,
      retryCount: input.retryCount,
    });

    return { warning, notifications };
  }
}
