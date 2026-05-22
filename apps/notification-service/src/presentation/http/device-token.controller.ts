import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, Roles } from 'nest-keycloak-connect';
import { RegisterDeviceTokenUseCase } from '../../application/use-cases/register-device-token.use-case';
import { UnregisterDeviceTokenUseCase } from '../../application/use-cases/unregister-device-token.use-case';
import {
  DeviceTokenResponseDto,
  RegisterDeviceTokenRequestDto,
} from '../dtos/device-token.dtos';

interface JwtPayload {
  sub?: string;
}

@ApiTags('Device Tokens')
@ApiBearerAuth()
@Controller('notifications/devices')
export class DeviceTokenController {
  constructor(
    private readonly registerDeviceTokenUseCase: RegisterDeviceTokenUseCase,
    private readonly unregisterDeviceTokenUseCase: UnregisterDeviceTokenUseCase,
  ) {}

  @Post()
  @Roles({
    roles: [
      'realm:ADMIN',
      'realm:CENTER_MANAGER',
      'realm:INSTRUCTOR',
      'realm:STUDENT',
    ],
  })
  @ApiOperation({
    summary:
      'Đăng ký device token của người dùng hiện tại để nhận push notification',
  })
  async register(
    @AuthenticatedUser() user: JwtPayload,
    @Body() dto: RegisterDeviceTokenRequestDto,
  ): Promise<DeviceTokenResponseDto> {
    const record = await this.registerDeviceTokenUseCase.execute({
      userId: user.sub ?? '',
      token: dto.token,
      platform: dto.platform,
    });
    return record;
  }

  @Delete(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles({
    roles: [
      'realm:ADMIN',
      'realm:CENTER_MANAGER',
      'realm:INSTRUCTOR',
      'realm:STUDENT',
    ],
  })
  @ApiOperation({ summary: 'Huỷ đăng ký một device token theo giá trị token' })
  async unregister(@Param('token') token: string): Promise<void> {
    await this.unregisterDeviceTokenUseCase.execute(token);
  }
}
