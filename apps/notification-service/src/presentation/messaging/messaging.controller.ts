import { Controller, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { SendAcademicWarningUseCase } from '../../application/use-cases/send-academic-warning.use-case';
import { SendCourseUpdateUseCase } from '../../application/use-cases/send-course-update.use-case';
import { SendExamResultUseCase } from '../../application/use-cases/send-exam-result.use-case';
import { SendPasswordResetUseCase } from '../../application/use-cases/send-password-reset.use-case';
import { SendWelcomeEmailUseCase } from '../../application/use-cases/send-welcome-email.use-case';
import { NotificationMetrics } from '../../infrastructure/metrics/notification.metrics';
import { DEFAULT_RETRY_MAX_ATTEMPTS } from '../../infrastructure/messaging/rabbitmq.constants';
import { RetryPublisher } from '../../infrastructure/messaging/retry.publisher';

interface RetryablePayload {
  retryCount?: number;
}

interface IdentityUserCreatedPayload extends RetryablePayload {
  userId: string;
  email: string;
  fullName?: string;
}

interface PasswordResetRequestedPayload extends RetryablePayload {
  userId: string;
  email: string;
  resetUrl: string;
}

interface ExamSessionPayload extends RetryablePayload {
  studentId?: string;
  userId?: string;
  email?: string;
  sessionId?: string;
  licenseCategory?: string;
  score?: number;
}

interface AcademicWarningQueuedPayload extends RetryablePayload {
  studentId: string;
  reason: string;
  severity: string;
  message: string;
  createdById: string;
  studentEmail?: string;
  warningId?: string;
}

interface CourseUpdatedPayload extends RetryablePayload {
  recipientId: string;
  recipientEmail?: string;
  courseId: string;
  courseTitle: string;
  updateSummary: string;
}

@Controller()
export class MessagingController {
  private readonly logger = new Logger(MessagingController.name);

  constructor(
    private readonly sendWelcomeEmailUseCase: SendWelcomeEmailUseCase,
    private readonly sendExamResultUseCase: SendExamResultUseCase,
    private readonly sendAcademicWarningUseCase: SendAcademicWarningUseCase,
    private readonly sendPasswordResetUseCase: SendPasswordResetUseCase,
    private readonly sendCourseUpdateUseCase: SendCourseUpdateUseCase,
    private readonly retryPublisher: RetryPublisher,
    private readonly metrics: NotificationMetrics,
    private readonly configService: ConfigService,
  ) {}

  @EventPattern('identity.user.created')
  async handleUserCreated(
    @Payload() payload: IdentityUserCreatedPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await this.runWithRetry(
      'identity.user.created',
      payload,
      context,
      async () => {
        if (!payload.userId || !payload.email) return;
        await this.sendWelcomeEmailUseCase.execute({
          userId: payload.userId,
          email: payload.email,
          fullName: payload.fullName,
          retryCount: payload.retryCount,
        });
      },
    );
  }

  @EventPattern('identity.user.password-reset-requested')
  async handlePasswordReset(
    @Payload() payload: PasswordResetRequestedPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await this.runWithRetry(
      'identity.user.password-reset-requested',
      payload,
      context,
      async () => {
        if (!payload.userId || !payload.email || !payload.resetUrl) return;
        await this.sendPasswordResetUseCase.execute({
          userId: payload.userId,
          email: payload.email,
          resetUrl: payload.resetUrl,
          retryCount: payload.retryCount,
        });
      },
    );
  }

  @EventPattern('exam.session.passed')
  async handleExamPassed(
    @Payload() payload: ExamSessionPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await this.runWithRetry(
      'exam.session.passed',
      payload,
      context,
      async () => {
        const userId = payload.studentId ?? payload.userId;
        if (!userId) return;
        await this.sendExamResultUseCase.execute({
          eventType: 'exam.session.passed',
          userId,
          email: payload.email,
          licenseCategory: payload.licenseCategory,
          sessionId: payload.sessionId,
          score: payload.score,
          retryCount: payload.retryCount,
        });
      },
    );
  }

  @EventPattern('exam.session.failed')
  async handleExamFailed(
    @Payload() payload: ExamSessionPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await this.runWithRetry(
      'exam.session.failed',
      payload,
      context,
      async () => {
        const userId = payload.studentId ?? payload.userId;
        if (!userId) return;
        await this.sendExamResultUseCase.execute({
          eventType: 'exam.session.failed',
          userId,
          email: payload.email,
          licenseCategory: payload.licenseCategory,
          sessionId: payload.sessionId,
          score: payload.score,
          retryCount: payload.retryCount,
        });
      },
    );
  }

  @EventPattern('notification.academic-warning.queued')
  async handleAcademicWarningQueued(
    @Payload() payload: AcademicWarningQueuedPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await this.runWithRetry(
      'notification.academic-warning.queued',
      payload,
      context,
      async () => {
        await this.sendAcademicWarningUseCase.execute({
          studentId: payload.studentId,
          reason: payload.reason,
          severity: payload.severity,
          message: payload.message,
          createdById: payload.createdById,
          studentEmail: payload.studentEmail,
          warningId: payload.warningId,
          retryCount: payload.retryCount,
        });
      },
    );
  }

  @EventPattern('course.updated')
  async handleCourseUpdated(
    @Payload() payload: CourseUpdatedPayload,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    await this.runWithRetry('course.updated', payload, context, async () => {
      if (!payload.recipientId) return;
      await this.sendCourseUpdateUseCase.execute({
        userId: payload.recipientId,
        email: payload.recipientEmail,
        courseId: payload.courseId,
        courseTitle: payload.courseTitle,
        updateSummary: payload.updateSummary,
        retryCount: payload.retryCount,
      });
    });
  }

  private async runWithRetry<TPayload extends RetryablePayload>(
    eventPattern: string,
    payload: TPayload,
    context: RmqContext,
    handler: () => Promise<void>,
  ): Promise<void> {
    this.metrics.recordConsumed(eventPattern);
    const channel = context.getChannelRef() as {
      ack: (msg: unknown) => void;
      nack: (msg: unknown, allUpTo: boolean, requeue: boolean) => void;
    };
    const message = context.getMessage() as unknown;
    const retryCount = payload.retryCount ?? 0;
    const maxAttempts =
      Number(this.configService.get<number>('retry.maxAttempts')) ||
      DEFAULT_RETRY_MAX_ATTEMPTS;

    try {
      await handler();
      channel.ack(message);
    } catch (error) {
      const nextRetry = retryCount + 1;
      const reason = (error as Error).message;
      if (nextRetry > maxAttempts) {
        this.logger.error(
          `Dừng xử lý ${eventPattern} sau ${retryCount} lần retry: ${reason}; chuyển sang DLQ`,
        );
        channel.nack(message, false, false);
        return;
      }
      this.logger.warn(
        `Xử lý ${eventPattern} thất bại (lần ${nextRetry}/${maxAttempts}): ${reason}; đặt lịch retry`,
      );
      try {
        await this.retryPublisher.publishRetry({
          eventPattern,
          payload,
          retryCount: nextRetry,
        });
        channel.ack(message);
      } catch (publishError) {
        this.logger.error(
          `Đặt lịch retry cho ${eventPattern} thất bại: ${(publishError as Error).message}; chuyển sang DLQ`,
        );
        channel.nack(message, false, false);
      }
    }
  }
}
