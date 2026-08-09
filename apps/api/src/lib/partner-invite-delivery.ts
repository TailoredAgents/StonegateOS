import type { SendResult } from "@/lib/messaging";

export type PartnerInviteChannel = "email" | "sms";
export type PartnerInviteDeliveryState =
  | "succeeded"
  | "failed"
  | "reconciliation_required";

export type PartnerInviteProviderEvidence = {
  channel: PartnerInviteChannel;
  state: PartnerInviteDeliveryState;
  provider: string | null;
  providerOperationId: string | null;
  providerOperationIds: string[];
  providerIdempotencySupported: boolean;
  providerExactlyOnceClaimed: false;
  detail: string | null;
};

export type PartnerInviteDeliverySummary = {
  state: PartnerInviteDeliveryState;
  acceptedChannels: PartnerInviteChannel[];
  failedChannels: PartnerInviteChannel[];
  uncertainChannels: PartnerInviteChannel[];
  providerOperationIds: string[];
};

function providerOperationIds(result: SendResult): string[] {
  const candidates = [
    ...(Array.isArray(result.providerOperationIds)
      ? result.providerOperationIds
      : []),
    result.providerMessageId,
  ];
  return Array.from(
    new Set(
      candidates
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

/**
 * Provider acceptance is deliberately narrower than `ok`. Anything that is
 * not an explicit accepted/not-sent result is quarantined as uncertain.
 */
export function classifyPartnerInviteProviderResult(
  channel: PartnerInviteChannel,
  result: SendResult,
): PartnerInviteProviderEvidence {
  const operationIds = providerOperationIds(result);
  const state: PartnerInviteDeliveryState =
    result.ok && result.deliveryCertainty === "accepted"
      ? "succeeded"
      : !result.ok && result.deliveryCertainty === "not_sent"
        ? "failed"
        : "reconciliation_required";

  return {
    channel,
    state,
    provider: result.provider?.trim() || null,
    providerOperationId: operationIds[0] ?? null,
    providerOperationIds: operationIds,
    providerIdempotencySupported: result.providerIdempotencySupported === true,
    providerExactlyOnceClaimed: false,
    detail: result.detail?.trim() || null,
  };
}

export function summarizePartnerInviteDeliveries(
  evidence: readonly PartnerInviteProviderEvidence[],
): PartnerInviteDeliverySummary {
  const acceptedChannels = evidence
    .filter((item) => item.state === "succeeded")
    .map((item) => item.channel);
  const failedChannels = evidence
    .filter((item) => item.state === "failed")
    .map((item) => item.channel);
  const uncertainChannels = evidence
    .filter((item) => item.state === "reconciliation_required")
    .map((item) => item.channel);
  const state: PartnerInviteDeliveryState =
    uncertainChannels.length > 0
      ? "reconciliation_required"
      : acceptedChannels.length > 0
        ? "succeeded"
        : "failed";

  return {
    state,
    acceptedChannels,
    failedChannels,
    uncertainChannels,
    providerOperationIds: Array.from(
      new Set(evidence.flatMap((item) => item.providerOperationIds)),
    ),
  };
}
