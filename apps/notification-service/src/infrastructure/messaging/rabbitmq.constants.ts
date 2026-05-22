export const NOTIFICATION_QUEUE = 'notification_service_events';
export const NOTIFICATION_RETRY_QUEUE = 'notification_service_retry';
export const NOTIFICATION_DLQ = 'notification_service_dlq';

export const NOTIFICATION_RETRY_EXCHANGE = 'notification.retry';
export const NOTIFICATION_DLX_EXCHANGE = 'notification.dlx';

export const NOTIFICATION_RETRY_HEADER = 'x-notification-retry-count';

/**
 * Default values; runtime values come from Consul KV
 * (notification-service/retry/max-attempts, retry.interval-ms).
 */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000;
