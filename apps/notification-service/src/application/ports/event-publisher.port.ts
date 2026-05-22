export abstract class NotificationEventPublisher {
  abstract publish(eventName: string, payload: unknown): Promise<void>;
}
