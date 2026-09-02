import { readFileSync } from "node:fs";
import {
  PARTNER_LAUNCH_PERSONAS,
  PARTNER_PERSONA_PRESENTATIONS,
  getPartnerPersonaPresentation,
} from "../../../site/src/app/partners/lib/persona-presentation";

const siteSource = (relativePath: string): string =>
  readFileSync(
    new URL(`../../../site/src/app/partners/${relativePath}`, import.meta.url),
    "utf8",
  );

describe("Partner persona presentation boundary", () => {
  it("covers every launch audience through one typed presentation module", () => {
    expect(PARTNER_LAUNCH_PERSONAS).toEqual([
      "contractor",
      "real_estate_agent",
      "property_manager",
      "commercial_client",
    ]);
    for (const persona of PARTNER_LAUNCH_PERSONAS) {
      const presentation = getPartnerPersonaPresentation(persona);
      expect(presentation).toBe(PARTNER_PERSONA_PRESENTATIONS[persona]);
      expect(presentation.overview.nextActions).toHaveLength(3);
      expect(presentation.booking.scopeChecklist.length).toBeGreaterThanOrEqual(
        4,
      );
      expect(presentation.booking.proofPresets).toHaveLength(2);
      expect(presentation.repeatWork.starterTemplates).toHaveLength(2);
    }
    expect(getPartnerPersonaPresentation("unexpected").key).toBe("fallback");
    expect(getPartnerPersonaPresentation(null).key).toBe("fallback");
  });

  it("keeps capabilities and account authority outside presentation config", () => {
    const presentationSource = siteSource("lib/persona-presentation.ts");
    const authorizationSource = readFileSync(
      new URL("../lib/partner-account-authorization.ts", import.meta.url),
      "utf8",
    );
    expect(getPartnerPersonaPresentation.length).toBe(1);
    expect(presentationSource).not.toMatch(
      /from ["'][^"']*(?:portal-context|authorization|permissions)[^"']*["']/u,
    );
    expect(presentationSource).not.toMatch(/roleKey\s*:/u);
    expect(presentationSource).not.toMatch(/capabilities\s*:/u);
    expect(presentationSource).not.toMatch(/permissions\s*:/u);
    expect(authorizationSource).not.toContain("persona-presentation");
  });

  it("requires existing capability filtering and explicit user action at every wired surface", () => {
    const overview = siteSource("(portal)/overview/page.tsx");
    const booking = siteSource("components/PartnerBookingWizard.tsx");
    const onboarding = siteSource("components/PartnerApplicationWorkspace.tsx");
    const checklist = siteSource("components/PartnerOnboardingChecklist.tsx");
    const repeatWork = siteSource("components/PartnerRepeatWorkManager.tsx");

    expect(overview).toContain("visiblePersonaTaskIds");
    expect(overview).toContain("capabilities?.schedule");
    expect(booking).toContain("onClick={() => applyProofPreset(preset)}");
    expect(booking).toContain("Nothing is applied until you choose a preset");
    expect(onboarding).toContain(
      "Suggestions do not select requested features",
    );
    expect(checklist).toContain("presentation.onboarding.checklistLead");
    expect(repeatWork).toContain(
      "These ideas do not create a template or select a service",
    );
  });
});
