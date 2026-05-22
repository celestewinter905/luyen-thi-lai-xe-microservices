export interface SendMailInput {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export abstract class MailProvider {
  abstract send(input: SendMailInput): Promise<void>;
}
