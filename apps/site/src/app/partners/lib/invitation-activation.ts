export type PartnerInvitationActivationQueued = {
  ok: true;
  activationRequired: true;
  deliveryStatus: "queued";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePartnerInvitationActivationQueued(
  value: unknown,
): PartnerInvitationActivationQueued | null {
  const allowedKeys = new Set([
    "ok",
    "activationRequired",
    "deliveryStatus",
    "correlationId",
  ]);
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => allowedKeys.has(key)) ||
    value["ok"] !== true ||
    value["activationRequired"] !== true ||
    value["deliveryStatus"] !== "queued" ||
    !(
      value["correlationId"] === undefined ||
      (typeof value["correlationId"] === "string" &&
        value["correlationId"].length >= 1 &&
        value["correlationId"].length <= 128)
    )
  ) {
    return null;
  }
  return {
    ok: true,
    activationRequired: true,
    deliveryStatus: "queued",
  };
}
