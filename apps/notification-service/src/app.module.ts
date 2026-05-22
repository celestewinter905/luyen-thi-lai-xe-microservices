import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ClientsModule, Transport } from '@nestjs/microservices';
import {
  makeCounterProvider,
  makeGaugeProvider,
  PrometheusModule,
} from '@willsoto/nestjs-prometheus';
import {
  AuthGuard,
  KeycloakConnectModule,
  KeycloakConnectOptions,
  PolicyEnforcementMode,
  ResourceGuard,
  RoleGuard,
  TokenValidation,
} from 'nest-keycloak-connect';
import { ConsulConfigFactory } from '@repo/common';
import Joi from 'joi';
import { NotificationEventPublisher } from './application/ports/event-publisher.port';
import { MailProvider } from './application/ports/mail.provider';
import { PushProvider } from './application/ports/push.provider';
import { NotificationDispatcher } from './application/use-cases/notification-dispatcher.service';
import {
  ListNotificationsUseCase,
  MarkNotificationReadUseCase,
} from './application/use-cases/notification.use-cases';
import { RegisterDeviceTokenUseCase } from './application/use-cases/register-device-token.use-case';
import { SendAcademicWarningUseCase } from './application/use-cases/send-academic-warning.use-case';
import { SendCourseUpdateUseCase } from './application/use-cases/send-course-update.use-case';
import { SendExamResultUseCase } from './application/use-cases/send-exam-result.use-case';
import { SendPasswordResetUseCase } from './application/use-cases/send-password-reset.use-case';
import { SendWelcomeEmailUseCase } from './application/use-cases/send-welcome-email.use-case';
import { UnregisterDeviceTokenUseCase } from './application/use-cases/unregister-device-token.use-case';
import { DeviceTokenRepository } from './domain/repositories/device-token.repository';
import { NotificationRepository } from './domain/repositories/notification.repository';
import {
  NOTIFICATION_DELIVERY_FAILED_TOTAL,
  NOTIFICATION_DELIVERY_SUCCESS_TOTAL,
  NOTIFICATION_DLQ_DEPTH,
  NOTIFICATION_MESSAGES_CONSUMED_TOTAL,
  NotificationMetrics,
} from './infrastructure/metrics/notification.metrics';
import {
  NOTIFICATION_EVENT_CLIENT,
  RabbitMqNotificationEventPublisher,
} from './infrastructure/messaging/notification-event.publisher';
import { RabbitMqTopologyService } from './infrastructure/messaging/rabbitmq-topology.service';
import { RetryPublisher } from './infrastructure/messaging/retry.publisher';
import { PrismaDeviceTokenRepository } from './infrastructure/persistence/prisma/prisma-device-token.repository';
import { PrismaNotificationRepository } from './infrastructure/persistence/prisma/prisma-notification.repository';
import { PrismaService } from './infrastructure/persistence/prisma/prisma.service';
import { FcmPushProvider } from './infrastructure/providers/fcm-push.provider';
import { SmtpMailProvider } from './infrastructure/providers/smtp.provider';
import { DeviceTokenController } from './presentation/http/device-token.controller';
import { NotificationController } from './presentation/http/notification.controller';
import { MessagingController } from './presentation/messaging/messaging.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [
        ConsulConfigFactory.create(
          Joi.object({
            nodeEnv: Joi.string()
              .valid(
                'development',
                'development-local',
                'staging',
                'production',
              )
              .default('development'),
            port: Joi.number().default(3000),
            database: Joi.object({
              url: Joi.string().required(),
              poolSize: Joi.number().default(10),
              connectionTimeout: Joi.number().default(5000),
            }).optional(),
            rabbitmq: Joi.object({
              url: Joi.string().required(),
              username: Joi.string().default('guest'),
              password: Joi.string().default('guest'),
              vhost: Joi.string().default('/'),
              connectionTimeout: Joi.number().default(10000),
              heartbeat: Joi.number().default(60),
            }).optional(),
            keycloak: Joi.object({
              authServerUrl: Joi.string().default('http://localhost:8080'),
              realm: Joi.string().default('luyen-thi-lai-xe-realm'),
              clientId: Joi.string().default('nestjs-backend'),
              clientSecret: Joi.string().optional(),
            }).default(),
            smtp: Joi.object({
              host: Joi.string().default('localhost'),
              port: Joi.number().default(1025),
              user: Joi.string().allow('').default(''),
              pass: Joi.string().allow('').default(''),
              from: Joi.string().default('no-reply@luyen-thi-lai-xe.local'),
            }).default(),
            push: Joi.object({
              fcmCredentials: Joi.string().allow('').default(''),
            }).default(),
            retry: Joi.object({
              maxAttempts: Joi.number().default(3),
              intervalMs: Joi.number().default(300000),
            }).default(),
          }).unknown(true),
          'notification-service',
        ),
      ],
      isGlobal: true,
    }),
    ClientsModule.registerAsync([
      {
        name: NOTIFICATION_EVENT_CLIENT,
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [
              configService.get<string>('rabbitmq.url') ??
                'amqp://localhost:5672',
            ],
            queue: 'notification_service_events',
            queueOptions: { durable: true },
          },
        }),
      },
    ]),
    PrometheusModule.register({
      defaultLabels: { service: 'notification-service' },
    }),
    KeycloakConnectModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService): KeycloakConnectOptions => ({
        authServerUrl: configService.getOrThrow<string>(
          'keycloak.authServerUrl',
        ),
        realm: configService.getOrThrow<string>('keycloak.realm'),
        clientId: configService.getOrThrow<string>('keycloak.clientId'),
        secret: configService.get<string>('keycloak.clientSecret') ?? '',
        policyEnforcement: PolicyEnforcementMode.PERMISSIVE,
        tokenValidation: TokenValidation.OFFLINE,
      }),
    }),
  ],
  controllers: [
    NotificationController,
    DeviceTokenController,
    MessagingController,
  ],
  providers: [
    PrismaService,
    { provide: NotificationRepository, useClass: PrismaNotificationRepository },
    { provide: DeviceTokenRepository, useClass: PrismaDeviceTokenRepository },
    { provide: MailProvider, useClass: SmtpMailProvider },
    { provide: PushProvider, useClass: FcmPushProvider },
    {
      provide: NotificationEventPublisher,
      useClass: RabbitMqNotificationEventPublisher,
    },
    NotificationDispatcher,
    SendWelcomeEmailUseCase,
    SendExamResultUseCase,
    SendAcademicWarningUseCase,
    SendPasswordResetUseCase,
    SendCourseUpdateUseCase,
    ListNotificationsUseCase,
    MarkNotificationReadUseCase,
    RegisterDeviceTokenUseCase,
    UnregisterDeviceTokenUseCase,
    RabbitMqTopologyService,
    RetryPublisher,
    NotificationMetrics,
    makeCounterProvider({
      name: NOTIFICATION_MESSAGES_CONSUMED_TOTAL,
      help: 'Total number of notification events consumed from RabbitMQ.',
      labelNames: ['event_type'],
    }),
    makeCounterProvider({
      name: NOTIFICATION_DELIVERY_SUCCESS_TOTAL,
      help: 'Total number of notifications delivered successfully.',
      labelNames: ['channel', 'event_type'],
    }),
    makeCounterProvider({
      name: NOTIFICATION_DELIVERY_FAILED_TOTAL,
      help: 'Total number of notification delivery failures.',
      labelNames: ['channel', 'event_type'],
    }),
    makeGaugeProvider({
      name: NOTIFICATION_DLQ_DEPTH,
      help: 'Current depth of the notification dead-letter queue.',
    }),
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
    { provide: APP_GUARD, useClass: ResourceGuard },
  ],
})
export class AppModule {}
