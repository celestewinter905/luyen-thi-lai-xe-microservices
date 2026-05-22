import { Injectable } from '@nestjs/common';
import {
  DeviceTokenRecord,
  DeviceTokenRepository,
} from '../../domain/repositories/device-token.repository';

export interface RegisterDeviceTokenInput {
  userId: string;
  token: string;
  platform: string;
}

@Injectable()
export class RegisterDeviceTokenUseCase {
  constructor(private readonly repository: DeviceTokenRepository) {}

  async execute(input: RegisterDeviceTokenInput): Promise<DeviceTokenRecord> {
    return this.repository.upsert(input);
  }
}
