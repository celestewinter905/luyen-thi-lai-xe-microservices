import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationStatus,
  NotificationType,
} from '@prisma/notification-client';
import { MailProvider } from '../ports/mail.provider';
import {
  PushMessage,
  PushProvider,
  PushSendResult,
} from '../ports/push.provider';
import { DeviceTokenRepository } from '../../domain/repositories/device-token.repository';
import {
  NotificationRecord,
  NotificationRepository,
} from '../../domain/repositories/notification.repository';
import { NotificationMetrics } from '../../infrastructure/metrics/notification.metrics';

export interface DispatchInput {
  eventType: string;
  userId: string;
  recipientEmail?: string;
  title: string;
  body: string;
  html?: string;
  data?: Record<string, unknown>;
  channels: NotificationType[];
  retryCount?: number;
}

/**
 * Coordinates the actual delivery (IN_APP record + optional email + optional push)
 * and keeps NotificationRecord status in sync.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    private readonly repository: NotificationRepository,
    private readonly deviceTokenRepository: DeviceTokenRepository,
    private readonly mailProvider: MailProvider,
    private readonly pushProvider: PushProvider,
    private readonly metrics: NotificationMetrics,
  ) {}

  async dispatch(input: DispatchInput): Promise<NotificationRecord[]> {
    const created: NotificationRecord[] = [];
    for (const channel of input.channels) {
      const record = await this.repository.createNotification({
        userId: input.userId,
        title: input.title,
        body: input.body,
        type: channel,
        eventType: input.eventType,
        data: input.data ?? {},
        status: NotificationStatus.QUEUED,
        retryCount: input.retryCount ?? 0,
      });

      try {
        await this.deliverOne(channel, record, input);
        const delivered = await this.repository.updateDeliveryStatus(
          record.id,
          {
            status: NotificationStatus.DELIVERED,
            deliveredAt: new Date(),
            errorMessage: null,
          },
        );
        this.metrics.recordSuccess(channel, input.eventType);
        created.push(delivered);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown delivery error';
        const failed = await this.repository.updateDeliveryStatus(record.id, {
          status: NotificationStatus.FAILED,
          errorMessage: message,
        });
        this.metrics.recordFailure(channel, input.eventType);
        created.push(failed);
        // Bubble up so the messaging layer can decide retry semantics.
        throw error;
      }
    }
    return created;
  }

  private async deliverOne(
    channel: NotificationType,
    record: NotificationRecord,
    input: DispatchInput,
  ): Promise<void> {
    if (channel === NotificationType.IN_APP) {
      // IN_APP is delivered by persisting the record; nothing else to do.
      return;
    }

    if (channel === NotificationType.EMAIL) {
      if (!input.recipientEmail) {
        throw new Error(
          `Không thể gửi thông báo EMAIL ${record.id}: thiếu địa chỉ email của người nhận`,
        );
      }
      await this.mailProvider.send({
        to: input.recipientEmail,
        subject: input.title,
        text: input.body,
        html: input.html,
      });
      return;
    }

    if (channel === NotificationType.PUSH) {
      const tokens = await this.deviceTokenRepository.findByUser(input.userId);
      if (tokens.length === 0) {
        this.logger.warn(
          `Người dùng ${input.userId} chưa đăng ký device token nào; bỏ qua push cho ${record.id}`,
        );
        return;
      }
      const message: PushMessage = {
        title: input.title,
        body: input.body,
        data: this.flattenData(input.data),
      };
      const result: PushSendResult = await this.pushProvider.sendToTokens(
        tokens.map((t) => t.token),
        message,
      );
      if (result.invalidTokens.length > 0) {
        await this.deviceTokenRepository.deleteManyTokens(result.invalidTokens);
        this.logger.log(
          `Đã xóa ${result.invalidTokens.length} device token không hợp lệ`,
        );
      }
      if (result.successCount === 0 && tokens.length > 0) {
        throw new Error('Tất cả push của thông báo này đều gửi thất bại');
      }
      return;
    }
  }

  private flattenData(
    data?: Record<string, unknown>,
  ): Record<string, string> | undefined {
    if (!data) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
  }
}
