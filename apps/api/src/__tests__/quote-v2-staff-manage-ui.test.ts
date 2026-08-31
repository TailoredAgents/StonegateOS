import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeQuoteV2ManagePage,
  quoteV2DeliveryIsRetryable,
  quoteV2LifecycleUiState,
  quoteV2ManageAmount,
  quoteV2ResendRecipientDefaults,
  quoteV2SendAttemptIsActive,
} from "../../../site/src/app/team/lib/quote-v2-management-model";

const ROOT = join(process.cwd(), "../..");
const NOW = new Date("2026-08-31T16:00:00.000Z").getTime();
const CURRENT_VERSION_ID = "4525ac04-9ae0-4dba-9912-78d9cc0a2c66";
const SOURCE_VERSION_ID = "71bc7d5c-a6e7-4568-bc73-8c04138aa25d";
const CHANGE_REQUEST_ID = "6de3ce03-028d-458f-bac8-e65447ad4540";

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function row() {
  return {
    id: "76c905b4-afd4-4e46-ae66-fba2d29a30fb",
    quoteNumber: "Q-2026-0042",
    aggregateState: "open",
    quoteRevision: 4,
    currentVersionId: "4525ac04-9ae0-4dba-9912-78d9cc0a2c66",
    publishedVersionId: "4525ac04-9ae0-4dba-9912-78d9cc0a2c66",
    versionNumber: 2,
    versionState: "issued",
    documentType: "range",
    audience: "commercial",
    client: { name: "Avery Client", company: "Acme Facilities" },
    project: {
      name: "Warehouse cleanout",
      purchaseOrder: "PO-42",
      property: {
        addressLine1: "42 Example Way",
        city: "Atlanta",
        state: "GA",
      },
    },
    totals: {
      minimumCents: 100_000,
      maximumCents: 125_000,
      depositCents: 20_000,
      currency: "USD",
    },
    expiresAt: "2026-09-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
    deliveryState: "delivered",
    owner: {
      id: "5fe7f338-8d02-45a6-bf5f-dc28cb2751df",
      name: "Jordan Sales",
    },
    bucket: "awaiting_client",
    nextAction: { code: "await_client", label: "Await client response" },
  };
}

function lifecycleDetail(): Record<string, unknown> {
  return {
    id: row().id,
    quoteNumber: row().quoteNumber,
    aggregateState: "open",
    quoteRevision: 7,
    currentVersionId: CURRENT_VERSION_ID,
    publishedVersionId: CURRENT_VERSION_ID,
    opportunity: { status: "open", stage: "quoted" },
    versions: [
      {
        id: CURRENT_VERSION_ID,
        versionNumber: 2,
        state: "issued",
        supersedesVersionId: null,
        expiresAt: "2026-09-30T12:00:00.000Z",
        documentSnapshot: {
          terms: { consentVersion: "fixed_quote-consent-v1" },
          pricing: {
            lineItems: [
              {
                id: "base-service",
                name: "Base service",
                optionGroupId: null,
              },
              {
                id: "option-haul",
                name: "Same-day haul",
                optionGroupId: "fulfillment",
                selectedByDefault: true,
              },
            ],
          },
        },
      },
    ],
    changeRequests: [],
  };
}

describe("Quote V2 staff management UI", () => {
  it("routes mobile Quotes to the shared responsive V2 workspace", () => {
    const mobile = source("apps/site/src/app/mobile/page.tsx");
    expect(mobile).toContain('activeScreen === "quotes"');
    expect(mobile).toContain("isQuoteV2StaffFeatureEnabled()");
    expect(mobile).toContain('redirect(quoteWorkspaceHref("manage"))');
  });

  it("keeps Instant Quotes compact and moves learning into Sales HQ", () => {
    const hub = source(
      "apps/site/src/app/team/components/QuotesHubSection.tsx",
    );
    const instant = source(
      "apps/site/src/app/team/components/InstantQuotesSection.tsx",
    );
    const sales = source(
      "apps/site/src/app/team/components/SalesScorecardSection.tsx",
    );
    expect(hub).toContain("InstantQuotesSection({ compact: true })");
    expect(instant).toContain("Instant quote handoffs");
    expect(instant).toContain("View learning in Sales HQ");
    expect(sales).toContain('id="instant-quote-learning"');
    expect(sales).toContain("Instant quote learning and performance");
  });

  it("normalizes a capability-blind cursor page and formats range cents", () => {
    const page = normalizeQuoteV2ManagePage({
      ok: true,
      quotes: [row()],
      nextCursor: "opaque-cursor",
    });
    expect(page).not.toBeNull();
    expect(page?.quotes[0]).toMatchObject({
      quoteNumber: "Q-2026-0042",
      bucket: "awaiting_client",
      nextAction: { code: "await_client" },
    });
    expect(quoteV2ManageAmount(page!.quotes[0]!)).toBe("$1,000.00–$1,250.00");
    expect(JSON.stringify(page)).not.toContain("shareToken");
  });

  it("fails closed on malformed financial or bucket fields", () => {
    expect(
      normalizeQuoteV2ManagePage({
        quotes: [{ ...row(), bucket: "everything" }],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      normalizeQuoteV2ManagePage({
        quotes: [
          {
            ...row(),
            totals: { ...row().totals, minimumCents: -1 },
          },
        ],
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("models active polling and permits retry only for a failed current-version channel", () => {
    const currentVersionId = "4525ac04-9ae0-4dba-9912-78d9cc0a2c66";
    const attempt = {
      quoteVersionId: currentVersionId,
      status: "processing",
    };
    const delivery = {
      id: "4a0f33e5-baf3-4544-a99a-a91839d44a35",
      channel: "sms",
      status: "failed",
    };
    expect(quoteV2SendAttemptIsActive({ status: "requested" })).toBe(true);
    expect(quoteV2SendAttemptIsActive(attempt)).toBe(true);
    expect(
      quoteV2SendAttemptIsActive({ status: "reconciliation_required" }),
    ).toBe(false);
    expect(
      quoteV2DeliveryIsRetryable({
        attempt,
        delivery,
        publishedVersionId: currentVersionId,
      }),
    ).toBe(true);
    expect(
      quoteV2DeliveryIsRetryable({
        attempt,
        delivery,
        publishedVersionId: "71bc7d5c-a6e7-4568-bc73-8c04138aa25d",
      }),
    ).toBe(false);
    expect(
      quoteV2DeliveryIsRetryable({
        attempt,
        delivery: { ...delivery, status: "delivered" },
        publishedVersionId: currentVersionId,
      }),
    ).toBe(false);
  });

  it("prefills a fresh resend from immutable issued-party evidence and the latest signer channel", () => {
    const versionId = "4525ac04-9ae0-4dba-9912-78d9cc0a2c66";
    expect(
      quoteV2ResendRecipientDefaults(
        {
          contact: {
            name: "Mutable CRM Name",
            email: "mutable@example.test",
            phone: "+14045550001",
          },
          versions: [
            {
              id: versionId,
              documentSnapshot: {
                parties: {
                  customerName: "Immutable Client",
                  attentionName: "Immutable Signer",
                  email: "issued@example.test",
                  phoneE164: "+14045550002",
                },
              },
            },
          ],
          sendAttempts: [
            {
              quoteVersionId: versionId,
              deliveries: [{ recipientRole: "signer", channel: "sms" }],
            },
          ],
        },
        versionId,
      ),
    ).toEqual({
      name: "Immutable Signer",
      email: "issued@example.test",
      phoneE164: "+14045550002",
      emailSelected: false,
      smsSelected: true,
    });
  });

  it("permits a staff decision only for the exact current unexpired issued version", () => {
    const state = quoteV2LifecycleUiState(lifecycleDetail(), NOW);
    expect(state).toMatchObject({
      quoteId: row().id,
      quoteRevision: 7,
      currentVersionId: CURRENT_VERSION_ID,
      publishedVersionId: CURRENT_VERSION_ID,
      canRecordDecision: true,
      canVoid: true,
      canArchive: false,
      consentVersion: "fixed_quote-consent-v1",
      optionChoices: [
        {
          id: "option-haul",
          label: "Same-day haul",
          selectedByDefault: true,
        },
      ],
    });
    expect(
      quoteV2LifecycleUiState(
        {
          ...lifecycleDetail(),
          versions: [
            {
              ...(
                lifecycleDetail()["versions"] as Array<Record<string, unknown>>
              )[0],
              expiresAt: "2026-08-30T12:00:00.000Z",
            },
          ],
        },
        NOW,
      )?.canRecordDecision,
    ).toBe(false);
  });

  it("makes an actionable change request quote-wide and selects only an exact valid resolution", () => {
    const openChange = {
      id: CHANGE_REQUEST_ID,
      quoteVersionId: CURRENT_VERSION_ID,
      status: "open",
      message: "Please separate the loading-dock scope.",
      ownerTaskId: "b1fb06f0-43cc-468d-83f6-f89214acdd0e",
      dueAt: "2026-08-31T20:00:00.000Z",
    };
    const unchanged = quoteV2LifecycleUiState(
      { ...lifecycleDetail(), changeRequests: [openChange] },
      NOW,
    );
    expect(unchanged).toMatchObject({
      canRecordDecision: false,
      openChangeRequest: { id: CHANGE_REQUEST_ID },
      changeResolution: {
        requestId: CHANGE_REQUEST_ID,
        sourceVersionId: CURRENT_VERSION_ID,
        canReopenUnchanged: true,
        replacementVersionId: null,
      },
    });

    const current = (
      lifecycleDetail()["versions"] as Array<Record<string, unknown>>
    )[0]!;
    const revised = quoteV2LifecycleUiState(
      {
        ...lifecycleDetail(),
        versions: [
          {
            ...current,
            id: CURRENT_VERSION_ID,
            supersedesVersionId: SOURCE_VERSION_ID,
          },
          {
            ...current,
            id: SOURCE_VERSION_ID,
            versionNumber: 1,
            state: "superseded",
            supersedesVersionId: null,
          },
        ],
        changeRequests: [{ ...openChange, quoteVersionId: SOURCE_VERSION_ID }],
      },
      NOW,
    );
    expect(revised?.changeResolution).toEqual({
      requestId: CHANGE_REQUEST_ID,
      sourceVersionId: SOURCE_VERSION_ID,
      canReopenUnchanged: false,
      replacementVersionId: CURRENT_VERSION_ID,
    });
  });

  it("allows terminal controls only in lifecycle states accepted by the service", () => {
    expect(
      quoteV2LifecycleUiState(
        {
          ...lifecycleDetail(),
          aggregateState: "accepted",
          opportunity: { status: "approved" },
        },
        NOW,
      )?.canArchive,
    ).toBe(false);
    expect(
      quoteV2LifecycleUiState(
        {
          ...lifecycleDetail(),
          aggregateState: "accepted",
          opportunity: { status: "won" },
        },
        NOW,
      )?.canArchive,
    ).toBe(true);
    expect(
      quoteV2LifecycleUiState(
        { ...lifecycleDetail(), aggregateState: "voided" },
        NOW,
      ),
    ).toMatchObject({ canVoid: false, canArchive: true });
  });

  it("uses server-side filters and exposes the required focused detail views", () => {
    const ui = source(
      "apps/site/src/app/team/components/QuoteV2ManageClient.tsx",
    );
    const bff = source(
      "apps/site/src/app/api/team/quotes/v2/[...segments]/route.ts",
    );
    const section = source(
      "apps/site/src/app/team/components/QuotesSection.tsx",
    );
    const lifecycle = source(
      "apps/site/src/app/team/components/QuoteV2LifecyclePanel.tsx",
    );
    for (const phrase of [
      "Needs action",
      "Drafts",
      "Awaiting client",
      "Accepted / booked",
      "Overview",
      "Proposal & versions",
      "Delivery & response",
      "Activity",
      "Create revision draft",
      "This preview contains no customer action capability",
      "New resend attempt",
      "Send immutable version again",
      "Retries this failed channel only",
      "bounded backoff",
      "Quote-send permission and an enabled sender",
    ]) {
      expect(ui).toContain(phrase);
    }
    expect(ui).toContain("URLSearchParams");
    expect(ui).toContain("nextCursor");
    expect(ui).toContain("QuoteV2LifecyclePanel");
    expect(ui).toContain("refreshAfterLifecycle");
    for (const phrase of [
      "Record client approval",
      "Record client decline",
      "Resolve with issued revision",
      "Reopen unchanged proposal",
      "More lifecycle actions",
      "Void quote",
      "Archive quote",
      "This is an explicit opt-in",
      "I confirm the named client provided this",
      'aria-live="polite"',
      "idempotencyKeyFor",
    ]) {
      expect(lifecycle).toContain(phrase);
    }
    for (const method of [
      "recordStaffDecision",
      "resolveChangeRequest",
      "voidQuote",
      "archiveQuote",
    ]) {
      expect(lifecycle).toContain(`client.${method}`);
    }
    expect(bff).toContain('upstreamQuery.set("engine", "v2")');
    expect(bff).toContain('permissions: "quotes.read"');
    expect(bff).toContain("containsCustomerSecret(payload)");
    expect(bff).toContain("send-attempts");
    expect(bff).toContain('permission: "quotes.send"');
    expect(bff).toContain("requiresRevision: true");
    expect(bff).toContain("safeReplay: true");
    expect(section).toContain("isQuoteV2SenderFeatureEnabled()");
    expect(section).toContain('principal.permissions, "quotes.send"');
  });
});
