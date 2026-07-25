import {
  decideInstantQuoteMediaBackfillSlot,
  indexInstantQuoteMediaBackfillRelations,
  type InstantQuoteMediaBackfillRelation,
} from "@/lib/appointment-media-backfill-policy";

function relation(
  overrides: Partial<InstantQuoteMediaBackfillRelation> = {},
): InstantQuoteMediaBackfillRelation {
  return {
    id: "relation-1",
    instantQuoteId: "quote-1",
    mediaAssetId: "asset-1",
    sortOrder: 0,
    sourceKey: "instant_quote_upload:asset-1",
    status: "ready",
    contactId: "contact-1",
    deletedAt: null,
    ...overrides,
  };
}

describe("instant quote media backfill policy", () => {
  it("reuses a ready durable relation instead of importing its public URL", () => {
    const relationsByQuote = indexInstantQuoteMediaBackfillRelations([
      relation(),
    ]);

    expect(
      decideInstantQuoteMediaBackfillSlot({
        instantQuoteId: "quote-1",
        sortOrder: 0,
        contactId: "contact-1",
        relationsByQuote,
      }),
    ).toMatchObject({
      action: "reuse",
      relation: { mediaAssetId: "asset-1" },
      relationCount: 1,
    });
  });

  it("retries a failed legacy import against its existing stable source key", () => {
    const relationsByQuote = indexInstantQuoteMediaBackfillRelations([
      relation({
        sourceKey: "instant_quote:quote-1:0",
        status: "failed",
      }),
    ]);

    expect(
      decideInstantQuoteMediaBackfillSlot({
        instantQuoteId: "quote-1",
        sortOrder: 0,
        contactId: "contact-1",
        relationsByQuote,
      }),
    ).toMatchObject({
      action: "retry",
      relation: { mediaAssetId: "asset-1" },
    });
  });

  it("retries an old cleanup-expired import instead of blocking its source key", () => {
    const relationsByQuote = indexInstantQuoteMediaBackfillRelations([
      relation({
        sourceKey: "instant_quote:quote-1:0",
        status: "expired",
        deletedAt: new Date("2026-07-23T16:00:00.000Z"),
      }),
    ]);

    expect(
      decideInstantQuoteMediaBackfillSlot({
        instantQuoteId: "quote-1",
        sortOrder: 0,
        contactId: "contact-1",
        relationsByQuote,
      }),
    ).toMatchObject({
      action: "retry",
      relation: { mediaAssetId: "asset-1" },
    });
  });

  it("does not replace an unavailable durable upload with a duplicate import", () => {
    const relationsByQuote = indexInstantQuoteMediaBackfillRelations([
      relation({ status: "failed" }),
    ]);

    expect(
      decideInstantQuoteMediaBackfillSlot({
        instantQuoteId: "quote-1",
        sortOrder: 0,
        contactId: "contact-1",
        relationsByQuote,
      }),
    ).toMatchObject({
      action: "blocked",
      reason: "durable_media_not_ready:failed",
    });
  });

  it("blocks a cross-contact relation rather than fetching a replacement", () => {
    const relationsByQuote = indexInstantQuoteMediaBackfillRelations([
      relation({ contactId: "different-contact" }),
    ]);

    expect(
      decideInstantQuoteMediaBackfillSlot({
        instantQuoteId: "quote-1",
        sortOrder: 0,
        contactId: "contact-1",
        relationsByQuote,
      }),
    ).toMatchObject({
      action: "blocked",
      reason: "cross_contact_media_forbidden",
    });
  });

  it("imports a slot only when no durable quote relation exists", () => {
    expect(
      decideInstantQuoteMediaBackfillSlot({
        instantQuoteId: "quote-1",
        sortOrder: 0,
        contactId: "contact-1",
        relationsByQuote: new Map(),
      }),
    ).toEqual({ action: "import", relationCount: 0 });
  });
});
