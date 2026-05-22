import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  MailProvider,
  SendMailInput,
} from '../../application/ports/mail.provider';

@Injectable()
export class SmtpMailProvider extends MailProvider implements OnModuleInit {
  private readonly logger = new Logger(SmtpMailProvider.name);
  private transporter!: Transporter;
  private fromAddress!: string;

  constructor(private readonly configService: ConfigService) {
    super();
  }

  onModuleInit(): void {
    const host = this.configService.get<string>('smtp.host') ?? 'localhost';
    const port = Number(this.configService.get<number>('smtp.port') ?? 1025);
    const user = this.configService.get<string>('smtp.user') ?? '';
    const pass = this.configService.get<string>('smtp.pass') ?? '';
    this.fromAddress =
      this.configService.get<string>('smtp.from') ??
      'no-reply@luyen-thi-lai-xe.local';

    const auth = user ? { user, pass } : undefined;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth,
    });
    this.logger.log(`Đã sẵn sàng kết nối SMTP (host=${host} port=${port})`);
  }

  async send(input: SendMailInput): Promise<void> {
    const info = await this.transporter.sendMail({
      from: this.fromAddress,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    this.logger.log(`Đã gửi email tới ${input.to} (id=${info.messageId})`);
  }
}
