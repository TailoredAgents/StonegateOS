export type InboxComposerChannel = "sms" | "email" | "dm" | "web";
export type InboxComposerAudience = "" | "partner" | "internal";

export type InboxPreparedMessage = {
  version: 1;
  employeeId: string;
  threadId: string;
  contactId: string | null;
  channel: InboxComposerChannel;
  operationKey: string;
  payload: {
    body: string;
    direction: "outbound";
    channel: InboxComposerChannel;
    expectedContactId: string | null;
    subject?: string;
    audience?: "partner" | "internal";
    mediaUrls?: string[];
  };
};

export type InboxSendFailure = {
  ok: false;
  error: string;
  uncertain?: boolean;
};

export type InboxPrepareResult =
  | { ok: true; prepared: InboxPreparedMessage }
  | InboxSendFailure;

export type InboxSendResult =
  | {
      ok: true;
      threadId: string;
      messageId: string;
      channel: InboxComposerChannel;
      deliveryStatus: string;
      message: string;
    }
  | InboxSendFailure;

export function isInboxPreparedMessage(
  value: unknown,
): value is InboxPreparedMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const payload = input["payload"] as Record<string, unknown> | null;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "version",
          "employeeId",
          "threadId",
          "contactId",
          "channel",
          "operationKey",
          "payload",
        ].includes(key),
    )
  )
    return false;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  return (
    input["version"] === 1 &&
    typeof input["employeeId"] === "string" &&
    typeof input["threadId"] === "string" &&
    uuid.test(input["threadId"]) &&
    (input["contactId"] === null ||
      (typeof input["contactId"] === "string" &&
        uuid.test(input["contactId"]))) &&
    typeof input["channel"] === "string" &&
    ["sms", "email", "dm", "web"].includes(input["channel"]) &&
    typeof input["operationKey"] === "string" &&
    /^[A-Za-z0-9:_-]{16,160}$/u.test(input["operationKey"]) &&
    Boolean(
      payload &&
        !Array.isArray(payload) &&
        Object.keys(payload).every((key) =>
          [
            "body",
            "direction",
            "channel",
            "expectedContactId",
            "subject",
            "audience",
            "mediaUrls",
          ].includes(key),
        ) &&
        payload["direction"] === "outbound" &&
        payload["channel"] === input["channel"] &&
        payload["expectedContactId"] === input["contactId"] &&
        typeof payload["body"] === "string" &&
        (payload["subject"] === undefined ||
          typeof payload["subject"] === "string") &&
        (payload["audience"] === undefined ||
          payload["audience"] === "partner" ||
          payload["audience"] === "internal") &&
        (payload["mediaUrls"] === undefined ||
          (Array.isArray(payload["mediaUrls"]) &&
            payload["mediaUrls"].every(
              (url) => typeof url === "string" && /^https?:\/\//u.test(url),
            ))),
    )
  );
}
