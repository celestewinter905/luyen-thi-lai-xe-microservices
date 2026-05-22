export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushSendResult {
  successCount: number;
  failureCount: number;
  invalidTokens: string[];
}

export abstract class PushProvider {
  abstract sendToTokens(
    tokens: string[],
    message: PushMessage,
  ): Promise<PushSendResult>;
}
