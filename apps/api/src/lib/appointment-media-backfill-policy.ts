export type InstantQuoteMediaBackfillRelation = {
  id: string;
  instantQuoteId: string;
  mediaAssetId: string;
  sortOrder: number;
  sourceKey: string | null;
  status: string;
  contactId: string | null;
  deletedAt: Date | null;
};

export type InstantQuoteMediaBackfillDecision =
  | {
      action: "import";
      relationCount: 0;
    }
  | {
      action: "reuse";
      relation: InstantQuoteMediaBackfillRelation;
      relationCount: number;
    }
  | {
      action: "retry";
      relation: InstantQuoteMediaBackfillRelation;
      relationCount: number;
    }
  | {
      action: "blocked";
      relation: InstantQuoteMediaBackfillRelation;
      relationCount: number;
      reason:
        | "cross_contact_media_forbidden"
        | "durable_media_deleted"
        | `durable_media_not_ready:${string}`;
    };

export function indexInstantQuoteMediaBackfillRelations(
  rows: readonly InstantQuoteMediaBackfillRelation[],
): Map<string, Map<number, InstantQuoteMediaBackfillRelation[]>> {
  const byQuote = new Map<
    string,
    Map<number, InstantQuoteMediaBackfillRelation[]>
  >();
  for (const row of rows) {
    let byOrder = byQuote.get(row.instantQuoteId);
    if (!byOrder) {
      byOrder = new Map();
      byQuote.set(row.instantQuoteId, byOrder);
    }
    const relations = byOrder.get(row.sortOrder) ?? [];
    relations.push(row);
    byOrder.set(row.sortOrder, relations);
  }
  return byQuote;
}

export function decideInstantQuoteMediaBackfillSlot(input: {
  instantQuoteId: string;
  sortOrder: number;
  contactId: string;
  relationsByQuote: ReadonlyMap<
    string,
    ReadonlyMap<number, readonly InstantQuoteMediaBackfillRelation[]>
  >;
}): InstantQuoteMediaBackfillDecision {
  const relations =
    input.relationsByQuote.get(input.instantQuoteId)?.get(input.sortOrder) ??
    [];
  if (relations.length === 0) {
    return { action: "import", relationCount: 0 };
  }

  const matchingContact = relations.filter(
    (relation) => relation.contactId === input.contactId,
  );
  const reusable = matchingContact.find(
    (relation) => relation.status === "ready" && !relation.deletedAt,
  );
  if (reusable) {
    return {
      action: "reuse",
      relation: reusable,
      relationCount: relations.length,
    };
  }

  const legacySourceKey = `instant_quote:${input.instantQuoteId}:${input.sortOrder}`;
  const retryable = matchingContact.find(
    (relation) =>
      relation.sourceKey === legacySourceKey &&
      ((!relation.deletedAt &&
        (relation.status === "failed" || relation.status === "processing")) ||
        relation.status === "expired" ||
        relation.status === "deleted"),
  );
  if (retryable) {
    return {
      action: "retry",
      relation: retryable,
      relationCount: relations.length,
    };
  }

  const relation = matchingContact[0] ?? relations[0]!;
  const reason =
    matchingContact.length === 0
      ? "cross_contact_media_forbidden"
      : relation.deletedAt
        ? "durable_media_deleted"
        : (`durable_media_not_ready:${relation.status}` as const);
  return {
    action: "blocked",
    relation,
    relationCount: relations.length,
    reason,
  };
}
