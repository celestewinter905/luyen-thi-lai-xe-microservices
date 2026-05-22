import { Injectable, NotFoundException } from '@nestjs/common';
import {
  NotificationStatus,
  NotificationType,
  Prisma,
} from '@prisma/notification-client';
import {
  AcademicWarningRecord,
  CreateNotificationInput,
  NotificationRecord,
  NotificationRepository,
  UpdateDeliveryStatusInput,
} from '../../../domain/repositories/notification.repository';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaNotificationRepository extends NotificationRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async createNotification(
    input: CreateNotificationInput,
  ): Promise<NotificationRecord> {
    const sentAt =
      input.sentAt ??
      (input.status === NotificationStatus.DELIVERED ? new Date() : null);
    return this.prisma.notification.create({
      data: {
        userId: input.userId,
        title: input.title,
        body: input.body,
        type: input.type ?? NotificationType.IN_APP,
        eventType: input.eventType ?? null,
        data: (input.data ?? {}) as Prisma.InputJsonValue,
        status: input.status ?? NotificationStatus.DELIVERED,
        retryCount: input.retryCount ?? 0,
        errorMessage: input.errorMessage ?? null,
        sentAt: sentAt,
        deliveredAt: input.deliveredAt ?? null,
      },
    });
  }

  async createAcademicWarning(input: {
    studentId: string;
    reason: string;
    severity: string;
    message: string;
    createdById: string;
  }): Promise<AcademicWarningRecord> {
    return this.prisma.academicWarning.create({ data: input });
  }

  async findByUser(
    userId: string,
    page: number,
    size: number,
  ): Promise<{ items: NotificationRecord[]; total: number }> {
    const skip = (page - 1) * size;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: size,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);
    return { items, total };
  }

  async markRead(id: string, userId: string): Promise<NotificationRecord> {
    const item = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!item) throw new NotFoundException('Notification not found');
    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async updateDeliveryStatus(
    id: string,
    input: UpdateDeliveryStatusInput,
  ): Promise<NotificationRecord> {
    return this.prisma.notification.update({
      where: { id },
      data: {
        status: input.status,
        retryCount: input.retryCount,
        errorMessage: input.errorMessage,
        deliveredAt: input.deliveredAt,
        sentAt:
          input.status === NotificationStatus.DELIVERED
            ? (input.deliveredAt ?? new Date())
            : undefined,
      },
    });
  }
}
