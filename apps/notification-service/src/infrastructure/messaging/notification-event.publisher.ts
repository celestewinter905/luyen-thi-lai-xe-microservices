import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { NotificationEventPublisher } from '../../application/ports/event-publisher.port';

export const NOTIFICATION_EVENT_CLIENT = 'NOTIFICATION_EVENT_CLIENT';

@Injectable()
export class RabbitMqNotificationEventPublisher extends NotificationEventPublisher {
  private readonly logger = new Logger(RabbitMqNotificationEventPublisher.name);

  constructor(
    @Inject(NOTIFICATION_EVENT_CLIENT) private readonly client: ClientProxy,
  ) {
    super();
  }

  async publish(eventName: string, payload: unknown): Promise<void> {
    try {
      await lastValueFrom(this.client.emit(eventName, payload));
      this.logger.log(`Đã publish event: ${eventName}`);
    } catch (error) {
      this.logger.error(
        `Publish event ${eventName} thất bại: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
