import fs from "node:fs";
import path from "node:path";
import {
  InstantQuoteHandoffFailure,
  mapInstantQuoteLeadSource,
  mapInstantQuoteLoadSize,
  mapInstantQuoteServices,
  resolveInstantQuoteTeamHandoff,
  type InstantQuoteHandoffSnapshot,
} from "@/lib/instant-quote-team-handoff";

const API_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");

function apiSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function repoSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relativePath), "utf8");
}

const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const PROPERTY_ID = "33333333-3333-4333-8333-333333333333";
const LEAD_ID = "44444444-4444-4444-8444-444444444444";

function validSnapshot(
  overrides: Partial<InstantQuoteHandoffSnapshot> = {},
): InstantQuoteHandoffSnapshot {
  return {
    quote: {
      id: QUOTE_ID,
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      source: "public_site",
      notes: "Garage cleanout; gate code is in the contact record.",
      jobTypes: ["furniture", "construction_debris"],
      perceivedSize: "medium_cleanout",
      aiResult: {
        loadFractionEstimate: 0.7,
        priceLow: 500,
        priceHigh: 700,
        priceLowDiscounted: 450,
        priceHighDiscounted: 630,
      },
    },
    relationshipBackfillAmbiguous: false,
    activeContactExists: true,
    propertyAssociationExists: true,
    leads: [
      {
        id: LEAD_ID,
        contactId: CONTACT_ID,
        propertyId: PROPERTY_ID,
        source: "google_ads",
      },
    ],
    ...overrides,
  };
}

describe("verified Team instant-quote handoff", () => {
  it("builds booking and full-quote prefill only from explicit relationships", () => {
    const handoff = resolveInstantQuoteTeamHandoff(validSnapshot());

    expect(handoff).toMatchObject({
      instantQuoteId: QUOTE_ID,
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      leadId: LEAD_ID,
      bookingPrefill: {
        appointmentType: "junk_removal",
        propertyId: PROPERTY_ID,
        priceRangeMinCents: 45_000,
        priceRangeMaxCents: 63_000,
        loadSize: {
          kind: "half_to_three_quarters",
          customLoads: null,
        },
        source: { type: "google" },
      },
      fullQuotePrefill: {
        propertyId: PROPERTY_ID,
        serviceIds: ["furniture", "construction-debris"],
        priceRangeMinCents: 45_000,
        priceRangeMaxCents: 63_000,
      },
    });
    expect(handoff.bookingPrefill.notes).toContain(`Instant quote ${QUOTE_ID}`);
    expect(handoff.bookingPrefill.notes).toContain("Quoted range: $450–$630");
    expect(handoff.bookingPrefill.notes).toContain(
      "Customer notes: Garage cleanout",
    );
  });

  it.each([
    [0.25, "quarter_to_half", null],
    [0.7, "half_to_three_quarters", null],
    [0.95, "three_quarters_to_full", null],
    [1.12, "custom", 1.25],
  ] as const)(
    "maps %s trailer loads to a practical booking selection",
    (loadFractionEstimate, kind, customLoads) => {
      expect(
        mapInstantQuoteLoadSize({
          loadFractionEstimate,
          perceivedSize: "ignored_when_estimate_is_valid",
        }),
      ).toEqual({ kind, customLoads });
    },
  );

  it("maps only supported attribution and full-quote services", () => {
    expect(mapInstantQuoteLeadSource("meta_messenger")).toEqual({
      type: "facebook",
    });
    expect(mapInstantQuoteLeadSource("public_site")).toBeNull();
    expect(mapInstantQuoteLeadSource("not_google")).toBeNull();
    expect(
      mapInstantQuoteServices([
        "single_item",
        "construction-debris",
        "demo_shed",
        "single_item",
      ]),
    ).toEqual(["single-item", "construction-debris"]);
  });

  it.each([
    [
      "missing explicit quote link",
      validSnapshot({
        quote: { ...validSnapshot().quote!, propertyId: null },
      }),
      "instant_quote_relationship_missing",
    ],
    [
      "reported backfill ambiguity",
      validSnapshot({ relationshipBackfillAmbiguous: true }),
      "instant_quote_relationship_ambiguous",
    ],
    [
      "missing property association",
      validSnapshot({ propertyAssociationExists: false }),
      "instant_quote_relationship_missing",
    ],
    [
      "no matching lead",
      validSnapshot({ leads: [] }),
      "instant_quote_relationship_missing",
    ],
    [
      "multiple leads",
      validSnapshot({
        leads: [
          validSnapshot().leads[0]!,
          { ...validSnapshot().leads[0]!, id: QUOTE_ID },
        ],
      }),
      "instant_quote_relationship_ambiguous",
    ],
    [
      "mismatched lead property",
      validSnapshot({
        leads: [{ ...validSnapshot().leads[0]!, propertyId: CONTACT_ID }],
      }),
      "instant_quote_relationship_missing",
    ],
    [
      "unusable price prefill",
      validSnapshot({
        quote: { ...validSnapshot().quote!, aiResult: {} },
      }),
      "instant_quote_prefill_invalid",
    ],
  ] as const)("rejects %s", (_label, snapshot, expectedCode) => {
    try {
      resolveInstantQuoteTeamHandoff(snapshot);
      throw new Error("expected handoff rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InstantQuoteHandoffFailure);
      expect(error).toMatchObject({ code: expectedCode, status: 409 });
    }
  });

  it("keeps the authenticated detail handoff on canonical Team routes with no customer PII in URLs", () => {
    const detail = repoSource(
      "apps/site/src/app/team/components/InstantQuoteDetail.tsx",
    );
    const handoffStart = detail.indexOf("const bookingHref");
    const renderStart = detail.indexOf("return (", handoffStart);
    const handoffLinks = detail.slice(handoffStart, renderStart);

    expect(handoffStart).toBeGreaterThan(-1);
    expect(handoffLinks).toContain('teamSurfaceHref("contacts"');
    expect(handoffLinks).toContain('quoteWorkspaceHref("create"');
    expect(handoffLinks).toContain("instantQuoteId");
    expect(handoffLinks).toContain("propertyId");
    expect(handoffLinks).not.toContain("contactName");
    expect(handoffLinks).not.toContain("contactPhone");
    expect(handoffLinks).not.toContain("quote.zip");
    expect(handoffLinks).not.toContain("/team/instant-quotes/${quote.id}?");
  });

  it("authenticates and verifies the handoff endpoint before returning prefill", () => {
    const route = apiSource("app/api/admin/instant-quotes/[id]/route.ts");
    const getStart = route.indexOf("export async function GET");
    const deleteStart = route.indexOf("export async function DELETE");
    const get = route.slice(getStart, deleteStart);

    expect(get.indexOf("isAdminRequest(request)")).toBeLessThan(
      get.indexOf("context.params"),
    );
    expect(get).toContain('requirePermission(request, "quotes.read")');
    expect(get).toContain("loadInstantQuoteTeamHandoff(getDb(), id)");
    expect(get).toContain('"Cache-Control": "no-store"');
  });

  it("re-verifies the quote in the booking transaction and links exactly one lead", () => {
    const route = apiSource("app/api/admin/booking/book/route.ts");
    const transactionStart = route.indexOf("db.transaction(async (tx)");
    const handoffLoad = route.indexOf(
      "loadInstantQuoteTeamHandoff(tx, instantQuoteId)",
      transactionStart,
    );
    const appointmentInsert = route.indexOf(
      ".insert(appointments)",
      handoffLoad,
    );

    expect(transactionStart).toBeGreaterThan(-1);
    expect(handoffLoad).toBeGreaterThan(transactionStart);
    expect(route.slice(transactionStart, handoffLoad)).toContain(
      '.for("update")',
    );
    expect(route.slice(handoffLoad, appointmentInsert)).toContain(
      "handoff.contactId !== contactId",
    );
    expect(route.slice(handoffLoad, appointmentInsert)).toContain(
      "handoff.propertyId !== propertyId",
    );
    expect(route.slice(handoffLoad, appointmentInsert)).toContain(
      'throw new Error("instant_quote_already_booked")',
    );
    expect(route.slice(appointmentInsert, appointmentInsert + 700)).toContain(
      "leadId: resolvedLeadId",
    );
    expect(route).toContain("instantQuoteId: result.instantQuoteId");
  });

  it("submits the verified quote ID with booking, never with an unrelated call", () => {
    const contactDetails = repoSource(
      "apps/site/src/app/team/components/ContactsDetailsPaneClient.tsx",
    );
    const callStart = contactDetails.indexOf("action={startContactCallAction}");
    const callEnd = contactDetails.indexOf("</form>", callStart);
    const bookingStart = contactDetails.indexOf(
      "action={bookAppointmentAction}",
    );
    const bookingEnd = contactDetails.indexOf("</form>", bookingStart);

    expect(callStart).toBeGreaterThan(-1);
    expect(bookingStart).toBeGreaterThan(callEnd);
    expect(contactDetails.slice(callStart, callEnd)).not.toContain(
      'name="instantQuoteId"',
    );
    expect(contactDetails.slice(bookingStart, bookingEnd)).toContain(
      'name="instantQuoteId"',
    );
    expect(contactDetails.slice(bookingStart, bookingEnd)).toContain(
      'name="source" value="team_instant_quote"',
    );
  });

  it("server-loads and checks both destination selections before prefilling", () => {
    const contacts = repoSource(
      "apps/site/src/app/team/components/ContactsSection.tsx",
    );
    const quoteBuilder = repoSource(
      "apps/site/src/app/team/components/QuoteBuilderSection.tsx",
    );
    const quoteBuilderClient = repoSource(
      "apps/site/src/app/team/components/QuoteBuilderClient.tsx",
    );
    const contactDetails = repoSource(
      "apps/site/src/app/team/components/ContactsDetailsPaneClient.tsx",
    );
    const action = repoSource("apps/site/src/app/team/actions.ts");

    expect(contacts).toContain("await loadInstantQuoteHandoff(principal");
    expect(contacts).toContain("verifyInstantQuoteHandoffSelection(");
    expect(contacts).toContain("instantQuoteHandoff={bookingHandoff}");
    expect(quoteBuilder).toContain("await loadInstantQuoteHandoff(principal");
    expect(quoteBuilder).toContain("propertyIsVisible");
    expect(quoteBuilder).toContain("instantQuotePrefill=");
    expect(action).toContain('payload["instantQuoteId"]');
    expect(action).toContain('payload["source"]');
    expect(quoteBuilderClient).toContain("appliedInstantQuoteId");
    expect(quoteBuilderClient).toContain(
      "appliedInstantQuoteId.current === instantQuoteId",
    );
    expect(quoteBuilderClient).toContain("const handoffLocked = Boolean(");
    expect(quoteBuilderClient).toContain(
      "contacts.filter((contact) => contact.id === initialContactId)",
    );
    expect(quoteBuilderClient).toContain("property.id === initialPropertyId");
    expect(contactDetails).toContain(
      "[contact.id, handoffAppointmentType, handoffInstantQuoteId]",
    );
    expect(contactDetails).not.toContain("[contact.id, instantQuoteHandoff]");
  });
});
