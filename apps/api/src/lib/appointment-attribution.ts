export type AppointmentAttributionValidation =
  | { ok: true }
  | {
      ok: false;
      field: "soldByMemberId" | "crewMembers" | "marketingMemberId";
      memberId: string;
    };

/**
 * Validates the complete attribution set against IDs read and locked as active
 * in the same transaction. Foreign keys prove identity exists; this contract
 * additionally prevents inactive members from receiving new attribution.
 */
export function validateActiveAppointmentAttribution(input: {
  activeMemberIds: ReadonlySet<string>;
  soldByMemberId: string;
  crewMemberIds: readonly string[];
  marketingMemberId: string | null;
}): AppointmentAttributionValidation {
  if (!input.activeMemberIds.has(input.soldByMemberId)) {
    return {
      ok: false,
      field: "soldByMemberId",
      memberId: input.soldByMemberId,
    };
  }

  const inactiveCrewMemberId = input.crewMemberIds.find(
    (memberId) => !input.activeMemberIds.has(memberId),
  );
  if (inactiveCrewMemberId) {
    return {
      ok: false,
      field: "crewMembers",
      memberId: inactiveCrewMemberId,
    };
  }

  if (
    input.marketingMemberId &&
    !input.activeMemberIds.has(input.marketingMemberId)
  ) {
    return {
      ok: false,
      field: "marketingMemberId",
      memberId: input.marketingMemberId,
    };
  }

  return { ok: true };
}
