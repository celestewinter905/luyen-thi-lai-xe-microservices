import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  DEFAULT_RETRY_INTERVAL_MS,
  NOTIFICATION_DLQ,
  NOTIFICATION_DLX_EXCHANGE,
  NOTIFICATION_QUEUE,
  NOTIFICATION_RETRY_EXCHANGE,
  NOTIFICATION_RETRY_QUEUE,
} from './rabbitmq.constants';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

/**
 * Declares the notification-service queues / exchanges / DLQ topology used for
 * retry-with-delay semantics:
 *
 *  notification_service_events  (main queue; DLX -> notification.dlx -> notification_service_dlq)
 *  notification_service_retry   (TTL queue; DLX -> default exchange -> notification_service_events)
 *  notification_service_dlq     (terminal dead-letter queue)
 */
@Injectable()
export class RabbitMqTopologyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqTopologyService.name);
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url =
      this.configService.get<string>('rabbitmq.url') ?? 'amqp://localhost:5672';
    const retryIntervalMs =
      Number(this.configService.get<number>('retry.intervalMs')) ||
      DEFAULT_RETRY_INTERVAL_MS;

    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();
      const ch = this.channel;

      // 1) DLX + DLQ
      await ch.assertExchange(NOTIFICATION_DLX_EXCHANGE, 'fanout', {
        durable: true,
      });
      await ch.assertQueue(NOTIFICATION_DLQ, { durable: true });
      await ch.bindQueue(NOTIFICATION_DLQ, NOTIFICATION_DLX_EXCHANGE, '');

      // 2) Main events queue with DLX
      await ch.assertQueue(NOTIFICATION_QUEUE, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': NOTIFICATION_DLX_EXCHANGE,
        },
      });

      // 3) Retry queue: after TTL, messages flow back to the main queue.
      // We use the default exchange (empty name) with the routing key set to the
      // main queue name so expired messages are re-routed there directly.
      await ch.assertExchange(NOTIFICATION_RETRY_EXCHANGE, 'fanout', {
        durable: true,
      });
      await ch.assertQueue(NOTIFICATION_RETRY_QUEUE, {
        durable: true,
        arguments: {
          'x-message-ttl': retryIntervalMs,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': NOTIFICATION_QUEUE,
        },
      });
      await ch.bindQueue(
        NOTIFICATION_RETRY_QUEUE,
        NOTIFICATION_RETRY_EXCHANGE,
        '',
      );

      this.logger.log(
        `RabbitMQ topology sẵn sàng: ${NOTIFICATION_QUEUE} <-> ${NOTIFICATION_RETRY_QUEUE} (TTL=${retryIntervalMs}ms) -> ${NOTIFICATION_DLQ}`,
      );
    } catch (error) {
      this.logger.error(
        `Khai báo RabbitMQ topology thất bại: ${(error as Error).message}`,
      );
      // Do not crash the service: messaging consumers will still attach to the
      // main queue once it becomes available; the consul/rabbitmq healthchecks
      // will surface real connectivity issues.
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch (error) {
      this.logger.warn(
        `Đóng channel RabbitMQ topology thất bại: ${(error as Error).message}`,
      );
    }
  }
}
