import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PARTNER_LAUNCH_PERSONAS,
  PARTNER_PERSONA_COPY_LIMITS,
  PARTNER_PERSONA_PRESENTATIONS,
  getPartnerPersonaPresentation,
  resolvePartnerPresentationPersona,
} from "./persona-presentation";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysIn(child),
  ]);
}

void test("resolves all four launch audiences and fails safely to generic presentation", () => {
  assert.deepEqual(PARTNER_LAUNCH_PERSONAS, [
    "contractor",
    "real_estate_agent",
    "property_manager",
    "commercial_client",
  ]);
  for (const persona of PARTNER_LAUNCH_PERSONAS) {
    assert.equal(resolvePartnerPresentationPersona(persona), persona);
    assert.equal(getPartnerPersonaPresentation(persona).key, persona);
  }
  assert.equal(
    resolvePartnerPresentationPersona("Real estate agent"),
    "real_estate_agent",
  );
  assert.equal(
    resolvePartnerPresentationPersona("property-management"),
    "property_manager",
  );
  for (const unknown of [
    null,
    undefined,
    "",
    "other",
    "billing",
    "invented_persona",
  ]) {
    assert.equal(resolvePartnerPresentationPersona(unknown), "fallback");
    assert.equal(getPartnerPersonaPresentation(unknown).key, "fallback");
  }
});

void test("keeps persona guidance bounded, safe, and complete for responsive surfaces", () => {
  for (const presentation of Object.values(PARTNER_PERSONA_PRESENTATIONS)) {
    assert.ok(
      presentation.label.length <= PARTNER_PERSONA_COPY_LIMITS.shortLabel,
    );
    assert.deepEqual(Object.keys(presentation.taskLabels).sort(), [
      "jobs",
      "locations",
      "proof",
      "repeat_work",
      "schedule",
    ]);
    assert.equal(presentation.overview.nextActions.length, 3);
    assert.equal(presentation.onboarding.nextActions.length, 3);
    assert.ok(presentation.booking.scopeChecklist.length >= 4);
    assert.equal(presentation.booking.proofPresets.length, 2);
    assert.equal(presentation.repeatWork.starterTemplates.length, 2);

    for (const value of stringsIn(presentation)) {
      assert.ok(
        value.length <= PARTNER_PERSONA_COPY_LIMITS.placeholder,
        `${presentation.key}: ${value}`,
      );
      assert.equal(/[\r\n]/u.test(value), false);
    }
    for (const preset of presentation.booking.proofPresets) {
      assert.match(preset.id, /^[a-z][a-z0-9_]{1,79}$/u);
      assert.ok(
        Number.isInteger(preset.before) &&
          preset.before >= 0 &&
          preset.before <= 40,
      );
      assert.ok(
        Number.isInteger(preset.after) &&
          preset.after >= 0 &&
          preset.after <= 40,
      );
      assert.equal(typeof preset.package, "boolean");
    }
  }
});

void test("persona presentation has no authorization or capability influence", () => {
  assert.equal(getPartnerPersonaPresentation.length, 1);
  const forbiddenKeys = new Set([
    "authorization",
    "capabilities",
    "permissions",
    "role",
    "roleKey",
    "scopes",
  ]);
  for (const key of keysIn(PARTNER_PERSONA_PRESENTATIONS)) {
    assert.equal(
      forbiddenKeys.has(key),
      false,
      `forbidden presentation key: ${key}`,
    );
  }
  const moduleSource = source("./persona-presentation.ts");
  assert.doesNotMatch(
    moduleSource,
    /from ["'][^"']*(?:portal-context|authorization|permissions)[^"']*["']/u,
  );
  assert.doesNotMatch(moduleSource, /can[A-Z][A-Za-z]+\s*:/u);
});

void test("wires dismissible and explicit persona suggestions without replacing saved values", () => {
  const overview = source("../(portal)/overview/page.tsx");
  const overviewGuide = source("../components/PartnerPersonaOverviewGuide.tsx");
  const booking = source("../components/PartnerBookingWizard.tsx");
  const application = source("../components/PartnerApplicationWorkspace.tsx");
  const checklist = source("../components/PartnerOnboardingChecklist.tsx");
  const repeatWork = source("../components/PartnerRepeatWorkManager.tsx");

  assert.match(overview, /visiblePersonaTaskIds/u);
  assert.match(overview, /capabilities\?\.schedule/u);
  assert.match(overviewGuide, /Dismiss persona suggestions/u);
  assert.match(overviewGuide, /Suggestions\s+change presentation only/u);

  assert.match(booking, /onClick=\{\(\) => applyProofPreset\(preset\)\}/u);
  assert.match(booking, /type="button"[\s\S]*aria-pressed=\{selected\}/u);
  assert.match(booking, /Nothing is applied until you choose a preset/u);
  assert.match(
    booking,
    /The controls[\s\n]+below always override the suggestion/u,
  );
  assert.match(booking, /formFromDraft\(initialDraft/u);
  assert.doesNotMatch(booking, /useEffect\([^)]*applyProofPreset/u);

  assert.match(application, /Suggestions do not select requested features/u);
  assert.match(application, /Dismiss persona onboarding suggestions/u);
  assert.match(checklist, /presentation\.onboarding\.checklistLead/u);
  assert.match(repeatWork, /do not create a template or select a service/u);
  assert.match(repeatWork, /Dismiss starter template suggestions/u);
});

void test("persona guidance retains accessible names, status, and responsive layouts", () => {
  const overviewGuide = source("../components/PartnerPersonaOverviewGuide.tsx");
  const booking = source("../components/PartnerBookingWizard.tsx");
  const application = source("../components/PartnerApplicationWorkspace.tsx");
  const repeatWork = source("../components/PartnerRepeatWorkManager.tsx");
  const combined = [overviewGuide, booking, application, repeatWork].join("\n");

  for (const id of [
    "partner-persona-next-actions-heading",
    "partner-persona-scope-heading",
    "partner-persona-proof-heading",
    "partner-starter-templates-heading",
  ]) {
    assert.match(
      combined,
      new RegExp(`aria-labelledby=["'{][^\\n]*${id}|id=["']${id}["']`, "u"),
    );
  }
  assert.match(booking, /role="status"/u);
  assert.match(booking, /aria-live="polite"/u);
  assert.match(combined, /min-h-11/u);
  assert.match(combined, /sm:grid-cols-2/u);
  assert.match(application, /sm:grid-cols-3/u);
});
