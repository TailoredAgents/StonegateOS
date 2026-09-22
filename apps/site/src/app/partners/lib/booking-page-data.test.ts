import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLocations,
  parseCatalogServices,
  parseBookingCatalog,
  parseProofDefaults,
  parseBookingDraft,
  parseBookingAvailability,
  parseBookingValidation,
  parseBookingDrafts,
} from "./booking-page-data";

const validDraft = {
  id: "saved-draft",
  state: "draft",
  etag: '"revision-1"',
  revision: 1,
  rescheduleFromJobId: null,
  additionalServiceFromJobId: null,
  locationId: null,
  serviceKey: null,
  tierKey: null,
  selectedAddOns: [],
  preferredWindows: [],
  reviewReasons: [],
  scope: {},
  proofRequirements: {},
  commercial: {},
  validation: {},
  description: null,
  crewInstructions: null,
  accessDetails: null,
  onSiteContact: null,
  scheduleAssistancePreference: "none",
  expiresAt: null,
  submittedAt: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};

void test("saved request lists reject broken records and pagination without erasing valid drafts", () => {
  assert.deepEqual(
    parseBookingDrafts({ ok: true, drafts: [], page: { nextCursor: null } }),
    { drafts: [], nextCursor: null },
  );
  assert.deepEqual(
    parseBookingDrafts({
      ok: true,
      drafts: [validDraft],
      page: { nextCursor: "next" },
    }),
    { drafts: [validDraft], nextCursor: "next" },
  );
  assert.equal(
    parseBookingDrafts({
      ok: true,
      drafts: [validDraft, null],
      page: { nextCursor: null },
    }),
    null,
  );
  assert.equal(parseBookingDrafts({ ok: true, drafts: [], page: {} }), null);
});

void test("a new ordinary account has a valid empty location list without portfolio tools", () => {
  assert.deepEqual(
    parseLocations({
      ok: true,
      locations: [],
      directory: { canCreateLocation: true, canManagePortfolio: false },
    }),
    [],
  );
});

void test("missing or broken location and catalog data never becomes an empty list", () => {
  for (const payload of [
    null,
    {},
    { ok: true },
    { ok: false, locations: [], services: [] },
  ]) {
    assert.equal(parseLocations(payload), null);
    assert.equal(parseCatalogServices(payload), null);
  }
  assert.equal(
    parseLocations({
      ok: true,
      locations: [{ id: "broken", active: true, address: null }],
      directory: { canCreateLocation: true },
    }),
    null,
  );
  assert.equal(
    parseCatalogServices({
      ok: true,
      services: [{ key: "junk-removal", label: null }],
    }),
    null,
  );
  assert.deepEqual(parseCatalogServices({ ok: true, services: [] }), []);
});

void test("catalog requirements retain bare, scope-prefixed and custom field paths", () => {
  const requiredScopeFields = [
    "itemCount",
    "scope.volumeCubicYards",
    " description ",
    "scope.requiredCompletion.localDate",
    "customJobDetail",
  ];
  const parsed = parseCatalogServices({
    ok: true,
    services: [
      {
        key: "junk-removal",
        label: "Junk removal",
        requiredScopeFields,
      },
    ],
  });
  assert.ok(parsed);
  assert.deepEqual(parsed[0]?.requiredScopeFields, [
    "itemCount",
    "scope.volumeCubicYards",
    "description",
    "scope.requiredCompletion.localDate",
    "customJobDetail",
  ]);
  assert.notEqual(parsed[0]?.requiredScopeFields, requiredScopeFields);
  assert.equal(requiredScopeFields[2], " description ");
});

void test("catalog responses without requirements remain compatible and empty lists stay explicit", () => {
  const legacy = parseCatalogServices({
    ok: true,
    services: [{ key: "junk-removal", label: "Junk removal" }],
  });
  assert.ok(legacy?.[0]);
  assert.equal(Object.hasOwn(legacy[0], "requiredScopeFields"), false);
  const empty = parseCatalogServices({
    ok: true,
    services: [
      {
        key: "junk-removal",
        label: "Junk removal",
        requiredScopeFields: [],
      },
    ],
  });
  assert.deepEqual(empty?.[0]?.requiredScopeFields, []);
});

void test("malformed catalog requirements fail the whole catalog instead of hiding required fields", () => {
  for (const requiredScopeFields of [
    null,
    "itemCount",
    { itemCount: true },
    ["itemCount", 1],
    ["itemCount", null],
    ["itemCount", ["volumeCubicYards"]],
    [""],
    ["   "],
  ]) {
    assert.equal(
      parseCatalogServices({
        ok: true,
        services: [
          { key: "service_request", label: "General request" },
          { key: "junk-removal", label: "Junk removal", requiredScopeFields },
        ],
      }),
      null,
    );
  }
});

void test("proof requirements are checked before starting a service request", () => {
  assert.equal(parseProofDefaults({ ok: true }), null);
  assert.equal(
    parseProofDefaults({
      ok: true,
      requirements: [{ category: "before", required: true, minimumCount: "2" }],
    }),
    null,
  );
  assert.deepEqual(
    parseProofDefaults({
      ok: true,
      requirements: [
        { category: "before", required: true, minimumCount: 2 },
        { category: "after", required: false, minimumCount: 0 },
      ],
    }),
    { before: 2, after: 0 },
  );
});

void test("incomplete recovered drafts cannot initialize a new request", () => {
  assert.equal(
    parseBookingDraft({
      ok: true,
      draft: { id: "saved-draft", state: "draft" },
    }),
    null,
  );
  assert.equal(parseBookingDraft({ ok: true, draft: validDraft }), validDraft);
  assert.equal(
    parseBookingDraft({
      ok: true,
      draft: { ...validDraft, selectedAddOns: [null] },
    }),
    null,
  );
  assert.equal(
    parseBookingDraft({
      ok: true,
      draft: { ...validDraft, preferredWindows: [null] },
    }),
    null,
  );
});

void test("request validation and scheduling responses must be complete before replacing saved data", () => {
  assert.equal(
    parseBookingValidation({
      ok: true,
      draft: validDraft,
      validation: { valid: true },
    }),
    null,
  );
  assert.equal(
    parseBookingValidation({
      ok: true,
      draft: validDraft,
      validation: {
        valid: false,
        ready: false,
        fieldErrors: { locationId: 42 },
      },
    }),
    null,
  );
  assert.equal(
    parseBookingValidation({
      ok: true,
      draft: validDraft,
      validation: { valid: true, ready: false, fieldErrors: {} },
    })?.draft,
    validDraft,
  );
  const availability = {
    draft: validDraft,
    timezone: "America/New_York",
    calendar: { state: "unconfigured" },
    reviewReasons: ["manual_review"],
    instantConfirmationEligible: false,
    pricing: {
      status: "review_required",
      currency: null,
      baseAmount: null,
      addOnTotal: null,
      total: null,
      addOns: [],
    },
    windows: [],
    rankedAlternatives: [],
  };
  assert.deepEqual(
    parseBookingAvailability({ ok: true, availability }),
    availability,
  );
  assert.equal(
    parseBookingAvailability({
      ok: true,
      availability: { ...availability, windows: [null] },
    }),
    null,
  );
  assert.equal(
    parseBookingAvailability({
      ok: true,
      availability: { ...availability, timezone: "Invalid/Place" },
    }),
    null,
  );
  assert.equal(
    parseBookingAvailability({
      ok: true,
      availability: { ...availability, pricing: { status: "review_required" } },
    }),
    null,
  );
});

void test("multi-service drafts preserve normalized service lines without singular legacy scope", () => {
  const line = {
    id: "11111111-1111-4111-8111-111111111111",
    serviceKey: "painting",
    description: "Paint the lobby",
    scope: { workArea: "interior" },
  };
  const draft = { ...validDraft, modelVersion: 2, serviceLines: [line] };
  const parsed = parseBookingDraft({ ok: true, draft });
  assert.ok(parsed);
  assert.deepEqual(parsed.serviceLines, [
    { ...line, selectedAddOns: [], proofRequirements: {} },
  ]);
  for (const patch of [
    { serviceKey: "painting" },
    { tierKey: "standard" },
    { selectedAddOns: [{ key: "stairs", quantity: 1 }] },
    { serviceLines: undefined },
    { serviceLines: [line, line] },
    { serviceLines: [{ ...line, scope: { itemCount: "3" } }] },
  ])
    assert.equal(
      parseBookingDraft({ ok: true, draft: { ...draft, ...patch } }),
      null,
    );
  assert.ok(
    parseBookingDraft({ ok: true, draft: { ...draft, serviceLines: [] } }),
    "An empty selection can be autosaved",
  );
});

void test("catalog capability and structured rates fail closed without hiding valid unpriced services", () => {
  const catalog = {
    ok: true,
    services: [{ key: "painting", label: "Painting", bookable: true }],
    requestModelVersion: 2,
    structuredRatesStatus: "missing",
    structuredRates: null,
  };
  assert.equal(parseBookingCatalog(catalog)?.multiServiceRequestsEnabled, true);
  assert.equal(
    parseBookingCatalog({ ...catalog, requestModelVersion: undefined })
      ?.multiServiceRequestsEnabled,
    false,
  );
  assert.equal(
    parseBookingCatalog({ ...catalog, requestModelVersion: 3 }),
    null,
  );
  assert.equal(
    parseBookingCatalog({ ...catalog, structuredRatesStatus: "published" }),
    null,
  );
  const card = {
    versionId: "22222222-2222-4222-8222-222222222222",
    currency: "USD",
    visitMinimum: "125.50",
    rates: [],
  };
  assert.deepEqual(
    parseBookingCatalog({
      ...catalog,
      structuredRatesStatus: "published",
      structuredRates: card,
    })?.structuredRates,
    card,
  );
  assert.equal(
    parseBookingCatalog({
      ...catalog,
      structuredRatesStatus: "hidden",
      structuredRates: card,
    }),
    null,
  );
  assert.equal(
    parseBookingCatalog({
      ...catalog,
      structuredRatesStatus: "published",
      structuredRates: { ...card, visitMinimum: "invalid" },
    }),
    null,
  );
});
