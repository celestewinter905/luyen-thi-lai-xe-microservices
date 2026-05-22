export interface DeviceTokenRecord {
  id: string;
  userId: string;
  token: string;
  platform: string;
  createdAt: Date;
  updatedAt: Date;
}

export abstract class DeviceTokenRepository {
  abstract upsert(input: {
    userId: string;
    token: string;
    platform: string;
  }): Promise<DeviceTokenRecord>;

  abstract findByUser(userId: string): Promise<DeviceTokenRecord[]>;

  abstract deleteByToken(token: string): Promise<void>;

  abstract deleteManyTokens(tokens: string[]): Promise<void>;
}
