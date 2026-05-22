import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import {
  PushMessage,
  PushProvider,
  PushSendResult,
} from '../../application/ports/push.provider';

const INVALID_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

@Injectable()
export class FcmPushProvider extends PushProvider implements OnModuleInit {
  private readonly logger = new Logger(FcmPushProvider.name);
  private app: admin.app.App | null = null;

  constructor(private readonly configService: ConfigService) {
    super();
  }

  onModuleInit(): void {
    const credentialsRaw = this.configService.get<string>(
      'push.fcmCredentials',
    );
    if (!credentialsRaw) {
      this.logger.warn(
        'push.fcmCredentials đang trống; push notification đã bị tắt. ' +
          'Cung cấp JSON service account của FCM để bật lại.',
      );
      return;
    }

    try {
      const parsed = JSON.parse(credentialsRaw) as admin.ServiceAccount;
      this.app = admin.apps.length
        ? admin.app()
        : admin.initializeApp({ credential: admin.credential.cert(parsed) });
      this.logger.log('Firebase Admin đã khởi tạo cho việc gửi push FCM');
    } catch (error) {
      this.logger.error(
        `Khởi tạo Firebase Admin thất bại: ${(error as Error).message}`,
      );
      this.app = null;
    }
  }

  async sendToTokens(
    tokens: string[],
    message: PushMessage,
  ): Promise<PushSendResult> {
    if (!this.app) {
      this.logger.warn(
        `FCM chưa được cấu hình; bỏ qua push tới ${tokens.length} token`,
      );
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }
    if (tokens.length === 0) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    const response = await admin.messaging(this.app).sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
    });

    const invalidTokens: string[] = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code ?? '';
        this.logger.warn(
          `Gửi push thất bại cho token index ${idx}: ${code} ${resp.error?.message ?? ''}`,
        );
        if (INVALID_TOKEN_ERRORS.has(code)) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens,
    };
  }
}
