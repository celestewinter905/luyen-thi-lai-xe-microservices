import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import {
  NotificationStatus,
  NotificationType,
} from '@prisma/notification-client';
import { NotificationRecord } from '../../domain/repositories/notification.repository';

export class SendAcademicWarningRequestDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiProperty({ example: 'HIGH' })
  @IsString()
  @IsNotEmpty()
  severity!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  message!: string;
}

export class AcademicWarningAcceptedResponseDto {
  @ApiProperty({ example: 'ACCEPTED' })
  status!: string;

  @ApiProperty({
    description:
      'Cảnh báo đã được đưa vào hàng đợi để gửi bất đồng bộ cho học viên.',
  })
  message!: string;
}

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  size?: number = 20;
}

export class NotificationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty({ enum: NotificationType }) type!: NotificationType;
  @ApiProperty({ nullable: true }) eventType!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() data!: unknown;
  @ApiProperty({ enum: NotificationStatus }) status!: NotificationStatus;
  @ApiProperty() retryCount!: number;
  @ApiProperty({ nullable: true }) errorMessage!: string | null;
  @ApiProperty() isRead!: boolean;
  @ApiProperty({ nullable: true }) readAt!: Date | null;
  @ApiProperty({ nullable: true }) sentAt!: Date | null;
  @ApiProperty({ nullable: true }) deliveredAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;

  static fromRecord(record: NotificationRecord): NotificationResponseDto {
    return Object.assign(new NotificationResponseDto(), record);
  }
}

export class ListNotificationsResponseDto {
  @ApiProperty({ type: [NotificationResponseDto] })
  items!: NotificationResponseDto[];

  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() size!: number;

  static fromResult(result: {
    items: NotificationRecord[];
    total: number;
    page: number;
    size: number;
  }): ListNotificationsResponseDto {
    const dto = new ListNotificationsResponseDto();
    dto.items = result.items.map(NotificationResponseDto.fromRecord);
    dto.total = result.total;
    dto.page = result.page;
    dto.size = result.size;
    return dto;
  }
}
