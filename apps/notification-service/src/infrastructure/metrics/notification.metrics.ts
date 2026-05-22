import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge } from 'prom-client';

export const NOTIFICATION_MESSAGES_CONSUMED_TOTAL =
  'notification_messages_consumed_total';
export const NOTIFICATION_DELIVERY_SUCCESS_TOTAL =
  'notification_delivery_success_total';
export const NOTIFICATION_DELIVERY_FAILED_TOTAL =
  'notification_delivery_failed_total';
export const NOTIFICATION_DLQ_DEPTH = 'notification_dlq_depth';

@Injectable()
export class NotificationMetrics {
  constructor(
    @InjectMetric(NOTIFICATION_MESSAGES_CONSUMED_TOTAL)
    private readonly consumed: Counter<string>,
    @InjectMetric(NOTIFICATION_DELIVERY_SUCCESS_TOTAL)
    private readonly success: Counter<string>,
    @InjectMetric(NOTIFICATION_DELIVERY_FAILED_TOTAL)
    private readonly failed: Counter<string>,
    @InjectMetric(NOTIFICATION_DLQ_DEPTH)
    private readonly dlqDepth: Gauge<string>,
  ) {}

  recordConsumed(eventType: string): void {
    this.consumed.inc({ event_type: eventType });
  }

  recordSuccess(channel: string, eventType?: string): void {
    this.success.inc({ channel, event_type: eventType ?? 'unknown' });
  }

  recordFailure(channel: string, eventType?: string): void {
    this.failed.inc({ channel, event_type: eventType ?? 'unknown' });
  }

  setDlqDepth(depth: number): void {
    this.dlqDepth.set(depth);
  }
}
