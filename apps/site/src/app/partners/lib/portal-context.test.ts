import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parsePartnerPortalAvailability,
  resolvePartnerPortalContext,
} from "./portal-context";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_A_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_B_ID = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_A_ID = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP_B_ID = "55555555-5555-4555-8555-555555555555";

function selectedAccountPayload() {
  return {
    ok: true,
    availability: {
      reads: true,
      writes: true,
      payments: { card: false, ach: false, hosted: false },
      uploads: { photos: true, documents: false },
      instantConfirmation: false,
    },
    partnerUser: {
      id: USER_ID,
      email: "partner@example.test",
      name: "Pat Partner",
      passwordSet: false,
    },
    account: {
      id: ACCOUNT_B_ID,
      name: "Selected Property Group",
      status: "portal_partner",
    },
    membership: {
      id: MEMBERSHIP_B_ID,
      roleKey: "viewer",
      persona: "property_manager",
      capabilities: ["account.read", "properties.read"],
    },
    accounts: [
      {
        id: ACCOUNT_A_ID,
        name: "Other Commercial Account",
        membershipId: MEMBERSHIP_A_ID,
        roleKey: "scheduler",
        persona: "commercial_client",
        capabilities: ["bookings.create", "properties.manage"],
        current: false,
        defaultAccount: false,
      },
      {
        id: ACCOUNT_B_ID,
        name: "Selected Property Group",
        membershipId: MEMBERSHIP_B_ID,
        roleKey: "viewer",
        persona: "property_manager",
        capabilities: ["account.read", "properties.read"],
        current: true,
        defaultAccount: true,
      },
    ],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

void test("V2 identity outages fail closed without calling the legacy profile", async () => {
  const calls: string[] = [];
  const thrown = await resolvePartnerPortalContext((path) => {
    calls.push(path);
    return Promise.reject(new Error("upstream unavailable"));
  });
  assert.deepEqual(thrown, { status: "unavailable" });
  assert.deepEqual(calls, ["/api/portal/v2/me"]);

  const unavailable = await resolvePartnerPortalContext((path) => {
    calls.push(path);
    return Promise.resolve(
      jsonResponse({ ok: false, error: "service_unavailable" }, 503),
    );
  });
  assert.deepEqual(unavailable, { status: "unavailable" });
  assert.deepEqual(calls, ["/api/portal/v2/me", "/api/portal/v2/me"]);
});

void test("service availability preserves sign-in and reading while disabling changes", async () => {
  const payload = selectedAccountPayload();
  payload.availability.writes = false;
  const capabilities = [
    "account.read",
    "jobs.read",
    "bookings.create",
    "bookings.update",
    "bookings.cancel",
    "properties.manage",
    "media.upload",
    "proof.request",
    "messages.send",
  ];
  payload.membership.capabilities = capabilities;
  payload.accounts[1]!.capabilities = capabilities;
  const context = await resolvePartnerPortalContext(() =>
    Promise.resolve(jsonResponse(payload)),
  );
  assert.equal(context.status, "authenticated");
  if (context.status !== "authenticated") return;
  assert.equal(context.capabilities.jobs, true);
  assert.equal(context.capabilities.schedule, false);
  for (const permission of [
    "scheduleJobs",
    "updateJobs",
    "cancelJobs",
    "manageLocations",
    "uploadMedia",
    "shareProof",
    "sendMessages",
  ] as const)
    assert.equal(context.permissions[permission], false);
});

void test("missing availability fails closed and inconsistent flags cannot enable writes or payments", async () => {
  const payload = selectedAccountPayload();
  const context = await resolvePartnerPortalContext(() =>
    Promise.resolve(jsonResponse({ ...payload, availability: undefined })),
  );
  assert.equal(context.status, "unavailable");
  const availability = parsePartnerPortalAvailability({
    reads: false,
    writes: true,
    payments: { card: true, ach: true, hosted: true },
    uploads: { photos: true, documents: true },
    instantConfirmation: true,
  });
  assert.deepEqual(availability, {
    reads: false,
    writes: false,
    payments: { card: false, ach: false, hosted: false },
    uploads: { photos: false, documents: false },
    instantConfirmation: false,
  });
});

void test("malformed V2 identities cannot inherit broad legacy capabilities", async () => {
  const malformedPayloads: unknown[] = [
    { ...selectedAccountPayload(), membership: { capabilities: ["*"] } },
    {
      ...selectedAccountPayload(),
      membership: {
        ...selectedAccountPayload().membership,
        capabilities: ["properties.read", 42],
      },
    },
    "not-json-object",
  ];

  for (const payload of malformedPayloads) {
    const calls: string[] = [];
    const context = await resolvePartnerPortalContext((path) => {
      calls.push(path);
      return Promise.resolve(jsonResponse(payload));
    });
    assert.deepEqual(context, { status: "unavailable" });
    assert.deepEqual(calls, ["/api/portal/v2/me"]);
  }
});

void test("the context binds capabilities to the one selected account membership", async () => {
  const context = await resolvePartnerPortalContext(() =>
    Promise.resolve(jsonResponse(selectedAccountPayload())),
  );
  assert.equal(context.status, "authenticated");
  if (context.status !== "authenticated") return;

  assert.equal(context.accountId, ACCOUNT_B_ID);
  assert.equal(context.membershipId, MEMBERSHIP_B_ID);
  assert.equal(context.accountLabel, "Selected Property Group");
  assert.deepEqual(context.accounts, [
    {
      id: ACCOUNT_A_ID,
      membershipId: MEMBERSHIP_A_ID,
      name: "Other Commercial Account",
      roleKey: "scheduler",
      current: false,
      defaultAccount: false,
    },
    {
      id: ACCOUNT_B_ID,
      membershipId: MEMBERSHIP_B_ID,
      name: "Selected Property Group",
      roleKey: "viewer",
      current: true,
      defaultAccount: true,
    },
  ]);
  assert.deepEqual(context.capabilities, {
    overview: true,
    schedule: false,
    jobs: false,
    approvals: false,
    locations: true,
    proof: false,
    billing: false,
    reports: false,
    help: true,
    settings: true,
  });
  assert.deepEqual(context.permissions, {
    scheduleJobs: false,
    updateJobs: false,
    cancelJobs: false,
    manageLocations: false,
    exportOperationalReports: false,
    readOperationalReports: false,
    readFinancialReports: false,
    exportFinancialReports: false,
    uploadMedia: false,
    shareProof: false,
    readMessages: false,
    sendMessages: false,
  });
});

void test("a mismatched current account and membership fails closed", async () => {
  const payload = selectedAccountPayload();
  payload.accounts[0]!.current = true;
  payload.accounts[1]!.current = false;
  const context = await resolvePartnerPortalContext(() =>
    Promise.resolve(jsonResponse(payload)),
  );
  assert.deepEqual(context, { status: "unavailable" });
});

void test("capabilities from another account cannot cross the selected-account boundary", async () => {
  const payload = selectedAccountPayload();
  payload.accounts[1]!.capabilities = payload.accounts[0]!.capabilities;
  const context = await resolvePartnerPortalContext(() =>
    Promise.resolve(jsonResponse(payload)),
  );
  assert.deepEqual(context, { status: "unavailable" });
});

void test("the protected locations page never loads contact-wide legacy addresses", () => {
  const source = readFileSync(
    new URL("../(portal)/properties/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /\/api\/portal\/v2\/locations/u);
  assert.match(source, /context\.capabilities\.locations/u);
  assert.match(source, /Location access is limited/u);
  assert.doesNotMatch(source, /\/api\/portal\/properties/u);
  assert.doesNotMatch(source, /legacyProperties/u);
});
