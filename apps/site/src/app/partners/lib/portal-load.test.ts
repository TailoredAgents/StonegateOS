import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPartnerPortalResource,
  portalLoadErrorMessage,
} from "./portal-load";
import {
  parsePortalJobs,
  parsePortalNotifications,
  parsePortalOverview,
  parsePortalProof,
} from "./portal-read-models";
import {
  parsePortalAccountProfile,
  parsePortalPersonalProfile,
  parsePortalTeam,
  parsePortalInvitations,
} from "./portal-settings-load";
import {
  parsePortalTemplates,
  parsePortalRecurringSeries,
  parsePortalBulkHistory,
  parsePortalBulkImport,
} from "./portal-repeat-load";

const json = (payload: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(payload), { status, headers });
const respond =
  (payload: unknown, status = 200, headers?: HeadersInit) =>
  () =>
    Promise.resolve(json(payload, status, headers));
const page = { nextCursor: null, hasMore: false };

void test("a verified empty account loads as empty; missing or malformed collections do not", async () => {
  const empty = await loadPartnerPortalResource(
    respond({ ok: true, jobs: [], page }),
    parsePortalJobs,
  );
  assert.equal(empty.status, "ok");
  if (empty.status === "ok")
    assert.deepEqual(empty.value, { items: [], nextCursor: null });
  for (const payload of [
    null,
    {},
    { ok: true },
    { ok: true, jobs: null, page },
    { ok: true, jobs: [], page: null },
    {
      ok: true,
      jobs: [{ id: "job", status: "requested", schedule: null }],
      page,
    },
  ]) {
    const result = await loadPartnerPortalResource(
      respond(payload),
      parsePortalJobs,
    );
    assert.equal(result.status, "error");
    if (result.status === "error")
      assert.equal(result.reason, "invalid_response");
  }
});

void test("authentication, permission, maintenance, missing records and outages remain distinct", async () => {
  for (const [status, code, reason] of [
    [401, "unauthorized", "auth"],
    [403, "forbidden", "permission"],
    [404, "feature_disabled", "disabled"],
    [404, "not_found", "not_found"],
    [503, "service_unavailable", "unavailable"],
    [409, "legacy_scope_unavailable", "unavailable"],
  ] as const) {
    const result = await loadPartnerPortalResource(
      respond({ ok: false, error: code }, status),
      parsePortalJobs,
    );
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.reason, reason);
  }
  const outage = await loadPartnerPortalResource(
    () => Promise.reject(new Error("offline")),
    parsePortalJobs,
  );
  assert.equal(outage.status, "error");
  if (outage.status === "error") assert.equal(outage.reason, "unavailable");
});

void test("incomplete JSON, failed HTTP responses and throwing parsers never report success", async () => {
  const responses = [
    new Response("not-json"),
    json({ ok: true, jobs: [], page }, 500),
    json({ jobs: [], page }),
  ];
  for (const response of responses) {
    const result = await loadPartnerPortalResource(
      () => Promise.resolve(response),
      parsePortalJobs,
    );
    assert.equal(result.status, "error");
  }
  const result = await loadPartnerPortalResource(respond({ ok: true }), () => {
    throw new Error("bad nested value");
  });
  assert.equal(result.status, "error");
});

void test("failed sections preserve safe support references without exposing upstream error text", async () => {
  const result = await loadPartnerPortalResource(
    respond(
      {
        ok: false,
        error: "service_unavailable",
        message: "private database detail",
        correlationId: "body_reference",
      },
      503,
      { "x-correlation-id": "portal_reference_123" },
    ),
    parsePortalJobs,
  );
  assert.equal(result.status, "error");
  if (result.status === "error") {
    const message = portalLoadErrorMessage(
      result,
      "Your jobs could not be loaded.",
    );
    assert.match(message, /Support reference: portal_reference_123/u);
    assert.doesNotMatch(message, /private database detail|body_reference/u);
  }
  const malformed = await loadPartnerPortalResource(
    respond({ ok: true }, 200, { "x-correlation-id": "portal_incomplete_123" }),
    parsePortalJobs,
  );
  if (malformed.status === "error")
    assert.match(
      portalLoadErrorMessage(malformed, "Try again."),
      /portal_incomplete_123/u,
    );
});

void test("Home validates absent data, money and arrival dates before rendering", () => {
  const empty = {
    ok: true,
    nextJob: null,
    savedRequest: null,
    outstandingBalances: [],
  };
  assert.deepEqual(parsePortalOverview(empty), empty);
  assert.equal(parsePortalOverview({ ...empty, nextJob: {} }), null);
  assert.equal(
    parsePortalOverview({
      ...empty,
      outstandingBalances: [
        { amountMinor: 50, currency: "broken", minorUnit: 2 },
      ],
    }),
    null,
  );
  assert.equal(
    parsePortalOverview({
      ...empty,
      nextJob: {
        id: "job",
        status: "requested",
        locationName: null,
        startAt: "not-a-date",
        endAt: null,
        timezone: "America/New_York",
      },
    }),
    null,
  );
});

void test("notification and proof pages reject one malformed item instead of dropping it", () => {
  assert.deepEqual(
    parsePortalNotifications({ ok: true, notifications: [], page }),
    { items: [], nextCursor: null },
  );
  assert.equal(
    parsePortalNotifications({
      ok: true,
      notifications: [{ id: "update" }],
      page,
    }),
    null,
  );
  const proof = {
    status: "not_required",
    requirements: [],
    outstanding: [],
    media: [],
    packages: [],
    shareLinks: [],
  };
  assert.deepEqual(parsePortalProof({ proof }), proof);
  assert.equal(parsePortalProof({ proof: { ...proof, media: [null] } }), null);
  assert.equal(parsePortalProof({ proof: { ...proof, packages: [{}] } }), null);
});

void test("settings must contain the nested records needed by their forms", () => {
  assert.equal(
    parsePortalAccountProfile({ ok: true, profile: { organization: null } }),
    null,
  );
  assert.equal(
    parsePortalTeam({
      ok: true,
      members: [{ allowedActions: null }],
      roles: [],
      invitation: {},
    }),
    null,
  );
  assert.equal(
    parsePortalPersonalProfile({
      ok: true,
      profile: { displayName: "Partner", updatedAt: "invalid" },
    }),
    null,
  );
  assert.deepEqual(
    parsePortalPersonalProfile({
      ok: true,
      profile: {
        displayName: "Partner",
        updatedAt: "2026-09-13T12:00:00.000Z",
      },
    })?.profile.displayName,
    "Partner",
  );
});

void test("validated profile reads retain the original strong ETag", async () => {
  const result = await loadPartnerPortalResource(
    respond(
      {
        ok: true,
        profile: {
          displayName: "Partner",
          updatedAt: "2026-09-13T12:00:00.000Z",
        },
      },
      200,
      { ETag: '"profile-revision-7"' },
    ),
    parsePortalPersonalProfile,
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok")
    assert.equal(result.response.headers.get("etag"), '"profile-revision-7"');
});

void test("a newly activated Administrator's actual team contract includes scope_update", async () => {
  // Shape captured from the normal members/invitations endpoints after real
  // local activation. A scope action is valid even without a Site scope editor.
  const date = "2026-09-13T12:00:00.000Z";
  const member = {
    id: "member",
    user: {
      name: "Partner Administrator",
      email: "partner@example.test",
      active: true,
    },
    role: {
      key: "administrator",
      name: "Administrator",
      description: "Company access",
    },
    status: "active",
    persona: "other",
    accessLevel: "account",
    currentUser: true,
    defaultAccount: true,
    dates: {
      invitedAt: date,
      acceptedAt: date,
      suspendedAt: null,
      updatedAt: date,
    },
    allowedActions: ["role_update", "scope_update"],
    etag: '"member-1"',
  };
  const payload = {
    ok: true,
    members: [member],
    roles: [
      {
        key: "administrator",
        name: "Administrator",
        description: "Company access",
        system: true,
      },
    ],
    invitation: { available: true, reason: null },
    page: { limit: 100, nextCursor: null, hasMore: false },
  };
  const result = await loadPartnerPortalResource(
    respond(payload),
    parsePortalTeam,
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok")
    assert.deepEqual(result.value.members[0]?.allowedActions, [
      "role_update",
      "scope_update",
    ]);
  assert.equal(
    parsePortalTeam({
      ...payload,
      members: [{ ...member, allowedActions: ["unknown"] }],
    }),
    null,
  );
  assert.ok(
    parsePortalInvitations({
      ok: true,
      invitations: [
        {
          id: "invitation",
          email: member.user.email,
          name: member.user.name,
          role: { key: "administrator" },
          access: { level: "account", locationIds: [], costCenterIds: [] },
          persona: "other",
          status: "accepted",
          delivery: { status: "accepted", sentAt: null },
          expiresAt: date,
          acceptedAt: date,
          activatedAt: date,
          revokedAt: null,
          createdAt: date,
          allowedActions: [],
          etag: '"invitation-1"',
        },
      ],
      page: { nextCursor: null },
      scopeOptions: { locations: [], costCenters: [], moreResults: false },
    }),
  );
});

void test("saved-tool histories require complete lists and preserve empty success separately", () => {
  for (const [key, parse] of [
    ["templates", parsePortalTemplates],
    ["series", parsePortalRecurringSeries],
    ["imports", parsePortalBulkHistory],
  ] as const) {
    assert.ok(parse({ ok: true, [key]: [], nextCursor: null }));
    assert.equal(parse({ ok: true, [key]: [null], nextCursor: null }), null);
    assert.equal(parse({ ok: true, [key]: [] }), null);
  }
  assert.equal(
    parsePortalBulkImport({ ok: true, import: { rows: null } }),
    null,
  );
});

void test("saved multi-service templates preserve normalized lines with no singular service fallback", () => {
  const line = {
    id: "11111111-1111-4111-8111-111111111111",
    serviceKey: "painting",
    description: "Paint the lobby",
    scope: { workArea: "interior" },
  };
  const item = {
    id: "template",
    name: "Saved work",
    active: true,
    serviceKey: null,
    locationId: null,
    updatedAt: "2026-09-21T00:00:00Z",
    etag: '"template-1"',
    reusable: { modelVersion: 2, serviceLines: [line] },
  };
  const parsed = parsePortalTemplates({
    ok: true,
    templates: [item],
    nextCursor: null,
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.templates[0]?.reusable?.serviceLines, [
    { ...line, selectedAddOns: [], proofRequirements: {} },
  ]);
  assert.equal(
    parsePortalTemplates({
      ok: true,
      templates: [{ ...item, reusable: { modelVersion: 2 } }],
      nextCursor: null,
    }),
    null,
  );
  assert.equal(
    parsePortalTemplates({
      ok: true,
      templates: [{ ...item, serviceKey: "painting" }],
      nextCursor: null,
    }),
    null,
  );
});
