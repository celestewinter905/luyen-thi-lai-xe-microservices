import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, Roles } from 'nest-keycloak-connect';
import { NotificationEventPublisher } from '../../application/ports/event-publisher.port';
import {
  ListNotificationsUseCase,
  MarkNotificationReadUseCase,
} from '../../application/use-cases/notification.use-cases';
import {
  AcademicWarningAcceptedResponseDto,
  ListNotificationsQueryDto,
  ListNotificationsResponseDto,
  NotificationResponseDto,
  SendAcademicWarningRequestDto,
} from '../dtos/notification.dtos';

interface JwtPayload {
  sub?: string;
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller()
export class NotificationController {
  constructor(
    private readonly listNotificationsUseCase: ListNotificationsUseCase,
    private readonly markNotificationReadUseCase: MarkNotificationReadUseCase,
    private readonly eventPublisher: NotificationEventPublisher,
  ) {}

  @Post('admin/academic-warnings')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles({ roles: ['realm:ADMIN', 'realm:CENTER_MANAGER', 'realm:INSTRUCTOR'] })
  @ApiOperation({
    summary:
      'Queue an academic warning notification for a student (async, returns 202).',
  })
  async sendAcademicWarning(
    @AuthenticatedUser() user: JwtPayload,
    @Body() dto: SendAcademicWarningRequestDto,
  ): Promise<AcademicWarningAcceptedResponseDto> {
    await this.eventPublisher.publish('notification.academic-warning.queued', {
      studentId: dto.studentId,
      reason: dto.reason,
      severity: dto.severity,
      message: dto.message,
      createdById: user.sub ?? '',
    });
    return {
      status: 'ACCEPTED',
      message:
        'Academic warning queued; the student will be notified asynchronously.',
    };
  }

  @Get('notifications/me')
  @Roles({
    roles: [
      'realm:ADMIN',
      'realm:CENTER_MANAGER',
      'realm:INSTRUCTOR',
      'realm:STUDENT',
    ],
  })
  @ApiOperation({ summary: 'List current user notifications' })
  async listMine(
    @AuthenticatedUser() user: JwtPayload,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<ListNotificationsResponseDto> {
    const result = await this.listNotificationsUseCase.execute(
      user.sub ?? '',
      query.page ?? 1,
      query.size ?? 20,
    );
    return ListNotificationsResponseDto.fromResult(result);
  }

  @Patch('notifications/:id/read')
  @Roles({
    roles: [
      'realm:ADMIN',
      'realm:CENTER_MANAGER',
      'realm:INSTRUCTOR',
      'realm:STUDENT',
    ],
  })
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markRead(
    @AuthenticatedUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<NotificationResponseDto> {
    const result = await this.markNotificationReadUseCase.execute(
      id,
      user.sub ?? '',
    );
    return NotificationResponseDto.fromRecord(result);
  }
}
