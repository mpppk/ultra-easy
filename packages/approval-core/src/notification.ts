import { Result } from "@praha/byethrow";

import type { ActionEvent } from "./action-event.ts";
import type { ActionRequestId, OrganizationId, UserId } from "./domain/brand.ts";

export type NotificationRequest = {
  organizationId: OrganizationId;
  actionRequestId: ActionRequestId;
  notificationKey: string;
  eventKey: string;
  eventType: ActionEvent["type"];
  event: ActionEvent;
  recipientUserId: UserId;
  occurredAt: string;
};

export class NotificationSinkError extends Error {
  readonly name = "NotificationSinkError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export interface NotificationSink {
  /**
   * notificationKey is a stable logical-delivery idempotency key.
   * Adapters should reuse it when calling downstream providers that support
   * idempotency so queue redelivery cannot create a second logical notification.
   */
  send(request: NotificationRequest): Result.ResultAsync<void, NotificationSinkError>;
}

export function notificationKeyForEvent(eventKey: string): string {
  return `notification:${eventKey}`;
}

export function notificationDeliveryKey(input: {
  notificationKey: string;
  recipientUserId: UserId;
}): string {
  return `${input.notificationKey}:user:${String(input.recipientUserId)}`;
}
