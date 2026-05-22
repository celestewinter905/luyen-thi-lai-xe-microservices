import { Injectable } from '@nestjs/common';
import {
  NotificationRecord,
  NotificationRepository,
} from '../../domain/repositories/notification.repository';

@Injectable()
export class ListNotificationsUseCase {
  constructor(private readonly repository: NotificationRepository) {}

  async execute(
    userId: string,
    page: number,
    size: number,
  ): Promise<{
    items: NotificationRecord[];
    total: number;
    page: number;
    size: number;
  }> {
    const safePage = Math.max(page, 1);
    const safeSize = Math.min(Math.max(size, 1), 100);
    const result = await this.repository.findByUser(userId, safePage, safeSize);
    return { ...result, page: safePage, size: safeSize };
  }
}

@Injectable()
export class MarkNotificationReadUseCase {
  constructor(private readonly repository: NotificationRepository) {}

  async execute(id: string, userId: string): Promise<NotificationRecord> {
    return this.repository.markRead(id, userId);
  }
}
