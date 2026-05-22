/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  ApiExceptionFilter,
  ApiResponseInterceptor,
  setupMicroserviceSwagger,
} from '@repo/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const rabbitmqUrl =
    configService.get<string>('rabbitmq.url') ?? 'amqp://localhost:5672';
  const port = configService.get<number>('port') ?? 3000;

  app.enableCors();
  app.useGlobalInterceptors(new ApiResponseInterceptor());
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new ApiExceptionFilter());

  setupMicroserviceSwagger(app, {
    title: 'Notification Service API',
    description:
      'Asynchronous notification dispatch (in-app, email via SMTP/Mailpit, FCM push). Consumes RabbitMQ events with retry-with-delay and DLQ.',
  });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: 'notification_service_events',
      queueOptions: { durable: true },
      noAck: false,
    },
  });

  await app.startAllMicroservices();
  await app.listen(port);
  console.log(`✓ Notification Service listening on port ${port}`);
  console.log(`  Metrics: http://localhost:${port}/metrics`);
}
void bootstrap();
