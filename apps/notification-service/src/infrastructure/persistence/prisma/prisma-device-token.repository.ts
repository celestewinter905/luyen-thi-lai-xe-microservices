import { Injectable } from '@nestjs/common';
import {
  DeviceTokenRecord,
  DeviceTokenRepository,
} from '../../../domain/repositories/device-token.repository';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaDeviceTokenRepository extends DeviceTokenRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async upsert(input: {
    userId: string;
    token: string;
    platform: string;
  }): Promise<DeviceTokenRecord> {
    return this.prisma.deviceToken.upsert({
      where: { token: input.token },
      create: input,
      update: { userId: input.userId, platform: input.platform },
    });
  }

  async findByUser(userId: string): Promise<DeviceTokenRecord[]> {
    return this.prisma.deviceToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteByToken(token: string): Promise<void> {
    await this.prisma.deviceToken
      .delete({ where: { token } })
      .catch(() => undefined);
  }

  async deleteManyTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.prisma.deviceToken.deleteMany({
      where: { token: { in: tokens } },
    });
  }
}
