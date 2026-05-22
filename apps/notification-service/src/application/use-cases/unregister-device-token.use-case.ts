import { Injectable } from '@nestjs/common';
import { DeviceTokenRepository } from '../../domain/repositories/device-token.repository';

@Injectable()
export class UnregisterDeviceTokenUseCase {
  constructor(private readonly repository: DeviceTokenRepository) {}

  async execute(token: string): Promise<void> {
    await this.repository.deleteByToken(token);
  }
}
