import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  NOTIFICATION_RETRY_EXCHANGE,
  NOTIFICATION_RETRY_HEADER,
} from './rabbitmq.constants';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

@Injectable()
export class RetryPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetryPublisher.name);
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;
  private url!: string;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.url =
      this.configService.get<string>('rabbitmq.url') ?? 'amqp://localhost:5672';
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch (error) {
      this.logger.warn(
        `Failed to close retry publisher channel: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Republish the original payload to the retry queue with an incremented
   * retry count carried in payload + AMQP headers.
   */
  async publishRetry(input: {
    eventPattern: string;
    payload: unknown;
    retryCount: number;
  }): Promise<void> {
    if (!this.channel) {
      await this.connect();
    }
    const ch = this.channel;
    if (!ch) {
      throw new Error('Retry channel is not available');
    }
    const basePayload =
      input.payload && typeof input.payload === 'object'
        ? (input.payload as Record<string, unknown>)
        : {};
    const envelope = {
      pattern: input.eventPattern,
      data: { ...basePayload, retryCount: input.retryCount },
    };
    ch.publish(
      NOTIFICATION_RETRY_EXCHANGE,
      '',
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: 'application/json',
        headers: {
          [NOTIFICATION_RETRY_HEADER]: input.retryCount,
          'x-original-event-pattern': input.eventPattern,
        },
      },
    );
    this.logger.log(
      `Scheduled retry #${input.retryCount} for ${input.eventPattern}`,
    );
  }

  private async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
      this.logger.log('Retry publisher connected to RabbitMQ');
    } catch (error) {
      this.logger.error(
        `Retry publisher failed to connect: ${(error as Error).message}`,
      );
    }
  }
}
