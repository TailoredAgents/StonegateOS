import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyQuoteV2AudienceDefaults,
  calculateQuoteV2OptimisticTotals,
  newQuoteV2ComposerDraft,
  quoteV2ContactResultLabel,
  quoteV2Readiness,
} from "../../../site/src/app/team/lib/quote-v2-composer-model";
import {
  QuoteV2StaffClient,
  quoteV2DraftDocument,
} from "../../../site/src/app/team/lib/quote-v2-client";
import { normalizeQuoteV2IfMatchRevision } from "../../../site/src/app/team/lib/quote-v2-proxy-contract";

const REPO_ROOT = join(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body.");
  }
  return init.body;
}

function completeDraft() {
  const base = newQuoteV2ComposerDraft("test", "commercial");
  return {
    ...base,
    contactId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
    propertyId: "6000319b-e380-4c14-bd60-7366f18c42e4",
    contact: {
      id: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
      name: "Alex Client",
      companyName: "Example Commercial",
      email: "alex@example.test",
      phoneE164: "+14045550123",
      title: "Facilities Manager",
      properties: [
        {
          id: "6000319b-e380-4c14-bd60-7366f18c42e4",
          label: "200 Service Way, Atlanta, GA 30302",
        },
      ],
    },
    projectName: "Warehouse cleanout",
    serviceZoneId: "zone-core",
    serviceZoneConfirmed: true,
    scope: "Remove and responsibly dispose of the listed material.",
    lines: [
      {
        ...base.lines[0]!,
        name: "Commercial cleanout",
        quantity: "1.125",
        unit: "load",
        unitPriceMin: "1000.00",
      },
    ],
    recipient: {
      ...base.recipient,
      name: "Alex Client",
      email: "alex@example.test",
      emailSelected: true,
    },
  };
}

describe("Quote V2 staff composer", () => {
  it("starts blank and applies adaptive audience defaults without selecting a client", () => {
    const residential = newQuoteV2ComposerDraft("draft");
    expect(residential).toMatchObject({
      contactId: "",
      propertyId: "",
      audience: "residential",
      validityDays: "14",
      schedulingMode: "self_schedule",
    });
    const commercial = applyQuoteV2AudienceDefaults(residential, "commercial");
    expect(commercial).toMatchObject({
      contactId: "",
      propertyId: "",
      audience: "commercial",
      validityDays: "30",
      schedulingMode: "staff_followup",
    });
  });

  it("calculates three-decimal quantities, visible adjustments, and deposits in cents", () => {
    const draft = completeDraft();
    draft.adjustments = [
      {
        id: "discount",
        kind: "discount",
        label: "Approved discount",
        calculation: "percentage",
        value: "10",
      },
      {
        id: "travel",
        kind: "travel",
        label: "Travel",
        calculation: "fixed",
        value: "25.00",
      },
    ];
    draft.deposit = { mode: "fixed", value: "250.00" };
    const totals = calculateQuoteV2OptimisticTotals(draft);
    expect(totals).toMatchObject({
      valid: true,
      subtotalMinCents: 112_500,
      subtotalMaxCents: 112_500,
      discountMinCents: 11_250,
      feeMinCents: 2_500,
      totalMinCents: 103_750,
      totalMaxCents: 103_750,
      depositCents: 25_000,
      balanceMinCents: 78_750,
    });
  });

  it("blocks readiness until pricing, scope, terms, and exactly one signer channel are complete", () => {
    const incomplete = newQuoteV2ComposerDraft("draft");
    expect(quoteV2Readiness(incomplete).ready).toBe(false);

    const complete = completeDraft();
    const result = quoteV2Readiness(complete);
    expect(result.ready).toBe(true);
    expect(result.completedCount).toBe(result.requirements.length);

    complete.recipient.emailSelected = false;
    expect(quoteV2Readiness(complete).ready).toBe(false);
  });

  it("serializes immutable customer facts with issuer/preparer/consent but excludes internal notes", () => {
    const draft = completeDraft();
    draft.internalNotes = "Never send this operational note";
    const document = quoteV2DraftDocument(draft, {
      preparerName: "Jordan Sales",
      issuer: {
        legalName: "Stonegate Services LLC",
        displayName: "Stonegate",
        address: "Woodstock, GA, US",
        email: "sales@example.test",
        phoneE164: "+14045550100",
      },
    });
    expect(document).toMatchObject({
      parties: { preparerName: "Jordan Sales" },
      issuer: { legalName: "Stonegate Services LLC" },
      terms: {
        templateVersion: "stonegate-commercial-v1",
        consentVersion: "fixed_quote-consent-v1",
      },
    });
    expect(JSON.stringify(document)).not.toContain("Never send");
    expect(document).not.toHaveProperty("internalNotes");
  });

  it("uses the same-origin V2 bridge with idempotency and verifies the server receipt", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher = (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: requestUrl(url), init });
      return Promise.resolve(
        Response.json(
          {
            ok: true,
            data: {
              quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
              versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
              quoteRevision: 1,
              draftRevision: 1,
              totals: null,
            },
          },
          { status: 201, headers: { "x-correlation-id": "quote.test-123" } },
        ),
      );
    };
    const client = new QuoteV2StaffClient({ fetcher: fetcher as typeof fetch });
    const receipt = await client.createDraft(
      completeDraft(),
      "quote-v2:create:00000000-0000-4000-8000-000000000001",
    );
    expect(receipt).toMatchObject({
      quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
      versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
      quoteRevision: 1,
      draftRevision: 1,
      correlationId: "quote.test-123",
    });
    expect(requests[0]?.url).toBe("/api/team/quotes/v2/quotes");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("idempotency-key")).toBe(
      "quote-v2:create:00000000-0000-4000-8000-000000000001",
    );
    expect(JSON.parse(requestBody(requests[0]?.init)) as unknown).toMatchObject(
      {
        confirmation: "create_quote_v2",
        contactId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
        propertyId: "6000319b-e380-4c14-bd60-7366f18c42e4",
      },
    );
  });

  it("issues one signer capability and separate CC/BCC view-only capabilities", async () => {
    let request: RequestInit | undefined;
    const client = new QuoteV2StaffClient({
      fetcher: ((_url: string | URL | Request, init?: RequestInit) => {
        request = init;
        return Promise.resolve(
          Response.json({
            ok: true,
            data: {
              quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
              versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
              quoteNumber: "Q-2026-42",
              sendAttemptId: "3c729b91-003c-42e0-950c-64cfbf11f347",
              overallState: "requested",
            },
          }),
        );
      }) as typeof fetch,
    });
    const draft = completeDraft();
    draft.additionalRecipients = [
      {
        id: "cc-1",
        role: "cc",
        name: "Finance Viewer",
        email: "finance@example.test",
        phoneE164: "",
        emailSelected: true,
        smsSelected: false,
      },
      {
        id: "bcc-1",
        role: "bcc",
        name: "Operations Viewer",
        email: "",
        phoneE164: "+14045550124",
        emailSelected: false,
        smsSelected: true,
      },
    ];
    await client.issue({
      quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
      versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
      quoteRevision: 2,
      draft,
      idempotencyKey: "quote-v2:issue:00000000-0000-4000-8000-000000000001",
    });
    const body = JSON.parse(requestBody(request)) as {
      recipients: Array<{ role: string; channels: string[] }>;
    };
    expect(body.recipients).toMatchObject([
      { role: "signer", channels: ["email"] },
      { role: "cc", channels: ["email"] },
      { role: "bcc", channels: ["sms"] },
    ]);
  });

  it("renders all four accessible steps, semantic team tokens, recovery, and sticky totals", () => {
    const component = source(
      "apps/site/src/app/team/components/QuoteV2ComposerClient.tsx",
    );
    for (const text of [
      "Client and project",
      "Items and scope",
      "Terms and fulfillment",
      "Review and send",
      "Internal notes — never customer visible",
      "Customer-selectable options",
      "View-only recipients",
      "Readiness checklist",
    ]) {
      expect(component).toContain(text);
    }
    expect(component).toContain('aria-label="Quote creation steps"');
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain("min-h-11");
    expect(component).toContain("sticky bottom-3");
    expect(component).toContain("var(--team-");
    expect(component).not.toContain("bg-white");
    expect(component).not.toContain("text-slate");
  });

  it("keeps the composer company-search promise backed by the server query", () => {
    const composer = source(
      "apps/site/src/app/team/components/QuoteV2ComposerClient.tsx",
    );
    const contactRoute = source("apps/api/app/api/admin/contacts/route.ts");
    expect(composer).toContain("Name, company, email, phone, or address");
    expect(contactRoute).toContain("ilike(contacts.company, likePattern)");
    expect(contactRoute).toContain("companyName: contact.company");
    expect(
      quoteV2ContactResultLabel({
        name: "Morgan Facilities",
        companyName: "Atlas Facilities",
      }),
    ).toBe("Atlas Facilities · Morgan Facilities");
    expect(
      quoteV2ContactResultLabel({
        name: "Atlas Facilities",
        companyName: "  atlas facilities  ",
      }),
    ).toBe("Atlas Facilities");
    expect(
      quoteV2ContactResultLabel({
        name: "Morgan Facilities",
        companyName: null,
      }),
    ).toBe("Morgan Facilities");
    expect(
      quoteV2ContactResultLabel({
        name: "M".repeat(500),
        companyName: "A".repeat(500),
      }).length,
    ).toBeLessThanOrEqual(483);
  });

  it("gates V2 and proxies only bounded, authorized, idempotent CAS mutations", () => {
    const section = source(
      "apps/site/src/app/team/components/QuoteBuilderSection.tsx",
    );
    const proxy = source(
      "apps/site/src/app/api/team/quotes/v2/[...segments]/route.ts",
    );
    const client = source("apps/site/src/app/team/lib/quote-v2-client.ts");
    expect(section).toContain("isQuoteV2StaffFeatureEnabled()");
    expect(proxy).toContain('permission: "quotes.write"');
    expect(proxy).toContain('permission: "quotes.send"');
    expect(proxy).toContain('"Idempotency-Key"');
    expect(proxy).toContain('"If-Match"');
    expect(proxy).toContain("readBoundedRequestBytes");
    expect(proxy).toContain("containsCustomerSecret");
    expect(client).toContain("`${this.basePath}/quotes`");
    expect(client).toContain("/draft`");
    expect(client).toContain("/finalize`");
    expect(client).toContain("/issue`");
    expect(client).toContain("((...args) => globalThis.fetch(...args))");
    expect(client).not.toContain("options.fetcher ?? fetch;");
  });

  it("normalizes strong and weak Quote CAS tags without accepting malformed quoting", () => {
    expect(normalizeQuoteV2IfMatchRevision("7")).toBe("7");
    expect(normalizeQuoteV2IfMatchRevision('"7"')).toBe("7");
    expect(normalizeQuoteV2IfMatchRevision('W/"7"')).toBe("7");
    expect(normalizeQuoteV2IfMatchRevision('W/"7')).toBe('"7');
    expect(normalizeQuoteV2IfMatchRevision(null)).toBe("");
  });
});
