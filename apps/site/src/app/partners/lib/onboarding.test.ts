import assert from "node:assert/strict";
import test from "node:test";
import { parsePartnerOnboardingApplicationResponse } from "./onboarding";

function applicationPayload(): Record<string, unknown> {
  return {
    ok: true,
    application: {
      id: "11111111-1111-4111-8111-111111111111",
      status: "draft",
      version: 1,
      email: "partner@example.test",
      emailVerified: true,
      name: "Pat Partner",
      phone: null,
      companyName: "Example Properties",
      website: "https://example.test",
      partnerType: "property_manager",
      serviceAreas: ["Atlanta", "Atlanta", ""],
      requestedNeeds: ["schedule_jobs", "unknown_internal_capability"],
      companyResolution: {
        choice: "join_existing",
        candidateId: "opaque-candidate",
        accountLabel: "Example Properties",
      },
      informationRequest: null,
      submittedAt: null,
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
    requirements: {
      termsVersion: "2026-09-01",
      privacyVersion: "2026-09-01",
      partnerTypes: ["contractor", "property_manager", "invented_persona"],
    },
  };
}

void test("onboarding responses require a verified bounded public contract", () => {
  const parsed = parsePartnerOnboardingApplicationResponse(
    applicationPayload(),
    '"application:1"',
  );
  assert.ok(parsed);
  assert.equal(parsed.application.etag, '"application:1"');
  assert.equal(parsed.application.email, "partner@example.test");
  assert.deepEqual(parsed.application.requestedNeeds, ["schedule_jobs"]);
  assert.deepEqual(parsed.requirements.partnerTypes, [
    "contractor",
    "property_manager",
  ]);
  assert.equal(
    parsed.application.companyResolution.candidateId,
    "opaque-candidate",
  );
});

void test("unknown lifecycle states and missing legal versions fail closed", () => {
  const unknown = applicationPayload();
  (unknown["application"] as Record<string, unknown>)["status"] =
    "staff_only_pending";
  assert.equal(parsePartnerOnboardingApplicationResponse(unknown, '"1"'), null);

  const missingTerms = applicationPayload();
  (missingTerms["requirements"] as Record<string, unknown>)["termsVersion"] =
    "";
  assert.equal(
    parsePartnerOnboardingApplicationResponse(missingTerms, '"1"'),
    null,
  );
});

void test("an application revision is mandatory", () => {
  assert.equal(
    parsePartnerOnboardingApplicationResponse(applicationPayload()),
    null,
  );
  const payload = applicationPayload();
  (payload["application"] as Record<string, unknown>)["etag"] = '"embedded:1"';
  assert.equal(
    parsePartnerOnboardingApplicationResponse(payload)?.application.etag,
    '"embedded:1"',
  );
});
