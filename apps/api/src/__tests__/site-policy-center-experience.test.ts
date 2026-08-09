import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POLICY_CATEGORIES,
  POLICY_CARD_DEFINITIONS,
  POLICY_TEMPLATE_CHANNELS,
  formatPolicyEditor,
  policyCardMatches,
} from "../../../site/src/app/team/components/policy-center-model";

const ROOT = join(process.cwd(), "../..");
const SECTION = readFileSync(
  join(ROOT, "apps/site/src/app/team/components/PolicyCenterSection.tsx"),
  "utf8",
);
const WORKSPACE = readFileSync(
  join(
    ROOT,
    "apps/site/src/app/team/components/PolicyCenterWorkspaceClient.tsx",
  ),
  "utf8",
);
const ACTIONS = readFileSync(
  join(ROOT, "apps/site/src/app/team/actions.ts"),
  "utf8",
);
const API_ROUTE = readFileSync(
  join(ROOT, "apps/api/app/api/admin/policy/route.ts"),
  "utf8",
);

describe("Policy Center experience contract", () => {
  it("organizes every retained card into the seven promised categories", () => {
    expect(POLICY_CATEGORIES.map((category) => category.label)).toEqual([
      "Business",
      "Service Area",
      "Booking",
      "Messaging",
      "Pricing",
      "Templates",
      "Reviews",
    ]);
    expect(POLICY_CARD_DEFINITIONS).toHaveLength(14);
    expect(new Set(POLICY_CARD_DEFINITIONS.map((card) => card.id)).size).toBe(
      POLICY_CARD_DEFINITIONS.length,
    );
    for (const category of POLICY_CATEGORIES) {
      expect(
        POLICY_CARD_DEFINITIONS.some((card) => card.category === category.id),
      ).toBe(true);
    }
  });

  it("searches titles, keywords, categories, and downstream surfaces", () => {
    const serviceArea = POLICY_CARD_DEFINITIONS.find(
      (card) => card.id === "service_area",
    );
    const templates = POLICY_CARD_DEFINITIONS.find(
      (card) => card.id === "templates",
    );
    expect(serviceArea).toBeDefined();
    expect(templates).toBeDefined();
    if (!serviceArea || !templates) return;

    expect(policyCardMatches(serviceArea, "all", "zip")).toBe(true);
    expect(policyCardMatches(serviceArea, "service-area", "Booking")).toBe(
      true,
    );
    expect(policyCardMatches(serviceArea, "messaging", "zip")).toBe(false);
    expect(policyCardMatches(templates, "all", "copy")).toBe(true);
  });

  it("renders isolated edit controls with stale-write protection", () => {
    expect(SECTION.match(/<PolicyCardShell/gu)).toHaveLength(14);
    expect(
      SECTION.match(/<PolicyExpectedVersionField setting=/gu),
    ).toHaveLength(14);
    expect(WORKSPACE).toContain("onInputCapture={markDirty}");
    expect(WORKSPACE).toContain("Revert unsaved changes");
    expect(WORKSPACE).toContain("form.reset()");
    expect(WORKSPACE).toContain("No unsaved changes");
    expect(WORKSPACE).toContain('window.addEventListener("beforeunload"');
    expect(WORKSPACE).toContain("Concurrent edits are protected");
    expect(WORKSPACE).toContain("your stale change is rejected and your input");
    expect(SECTION).toContain('name="expectedVersion"');
    expect(SECTION).toContain('name="idempotencyKey"');
    expect(ACTIONS).toContain('"If-Match": expectedVersion');
    expect(ACTIONS).toContain('"Idempotency-Key": idempotencyKey');
    expect(ACTIONS).toContain('"/api/admin/sales/autopilot/signature"');
    expect(ACTIONS).toContain("isConfirmedPolicyMutation(result, expectedKey)");
    expect(ACTIONS).toContain(
      "The server did not return a confirmed policy receipt",
    );
    expect(SECTION).toContain(
      "saving is disabled so an unknown version cannot be overwritten",
    );
    expect(API_ROUTE).toContain("pg_advisory_xact_lock");
    expect(API_ROUTE).toContain(
      'new TeamMutationFailure(\n          "conflict"',
    );
    expect(API_ROUTE).toContain("mutation.audit.insertSuccess(tx");
    expect(API_ROUTE).toContain("claimTeamMutationIdempotency(");
    expect(API_ROUTE).toContain("completeTeamMutationIdempotency(");
    expect(API_ROUTE).toContain("teamMutationSuccessResult(");
  });

  it("shows API-provided editor/time metadata and keeps raw JSON under Expert", () => {
    expect(SECTION).toContain("updatedBy: string | null");
    expect(SECTION).toContain("updatedAt: string | null");
    expect(SECTION).toContain("version: string");
    expect(SECTION).toContain("Expert: raw JSON");
    expect(SECTION).toContain("Raw policy JSON");
    expect(SECTION).not.toContain(">Advanced JSON<");
    expect(formatPolicyEditor(null, "member-1", "Devon")).toBe(
      "System default",
    );
    expect(formatPolicyEditor(null, "member-1", "Devon", true)).toBe(
      "System or legacy actor",
    );
    expect(formatPolicyEditor("member-1", "member-1", "Devon")).toBe(
      "You (Devon)",
    );
    expect(formatPolicyEditor("12345678-abcd", "member-1", "Devon")).toBe(
      "Team member 12345678",
    );
  });

  it("keeps permission, accessibility, validation, and failure contracts visible", () => {
    expect(SECTION).toContain('hasTeamPermission(principal, "policy.write")');
    expect(WORKSPACE).toContain("<fieldset disabled={!canWrite}");
    expect(WORKSPACE).toContain('role="alert"');
    expect(WORKSPACE).toContain('aria-live="polite"');
    expect(WORKSPACE).toContain("min-h-[44px]");
    expect(WORKSPACE).toContain("onInvalidCapture");
    expect(API_ROUTE).toContain(
      "validatePolicyValue(policyKey, payload.value)",
    );
    expect(API_ROUTE).toContain("{ status: 422 }");
  });

  it("uses one duplicate-free channel registry for visible and persisted templates", () => {
    for (const channels of Object.values(POLICY_TEMPLATE_CHANNELS)) {
      const keys = channels.map((channel) => channel.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(POLICY_TEMPLATE_CHANNELS.first_touch.map(({ key }) => key)).toEqual([
      "sms",
      "email",
      "dm",
      "call",
      "web",
    ]);
    expect(POLICY_TEMPLATE_CHANNELS.follow_up.map(({ key }) => key)).toEqual([
      "sms",
      "email",
      "dm",
    ]);
    expect(SECTION).toContain("POLICY_TEMPLATE_CHANNELS.first_touch.map");
    expect(SECTION).toContain("POLICY_TEMPLATE_CHANNELS.follow_up.map");
    expect(ACTIONS).toContain(
      "const followUpFields = POLICY_TEMPLATE_CHANNELS.follow_up",
    );
    expect(SECTION).toContain(
      "htmlFor={`policy-template-follow-up-${channel.key}`}",
    );
    expect(SECTION).toContain(
      "id={`policy-template-follow-up-${channel.key}`}",
    );
    expect(ACTIONS).toContain("reviewUrl: normalizedReviewUrl");
    expect(ACTIONS).toContain("Policy JSON must be an object");
  });
});
