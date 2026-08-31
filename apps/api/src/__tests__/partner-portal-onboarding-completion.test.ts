import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  PARTNER_PRIVACY_VERSION,
  PARTNER_LIMITED_ACCESS_CAPABILITIES,
  PARTNER_TERMS_VERSION,
  parsePartnerAccessApplication,
  parsePartnerJoinRequest,
  partnerApplicationIdentityHash,
} from "@/lib/partner-portal-onboarding";
import {
  parsePartnerNotificationPreference,
  PARTNER_NOTIFICATION_EVENT_KEYS,
} from "@/lib/partner-notification-preferences";
import {
  isAllowedPartnerPortalMutationOrigin,
  normalizeCompanyDomain,
  portalV2SessionHandle,
} from "@/lib/partner-portal-v2-security";

function validApplication(): Record<string, unknown> {
  return {
    email: "Partner@Acme.example",
    name: "Pat Partner",
    phone: "+1 (410) 555-0199",
    companyName: "Acme Property Group",
    website: "https://acme.example/partners",
    partnerType: "property_manager",
    serviceAreas: ["Baltimore", "Anne Arundel"],
    requestedNeeds: ["scheduled pickups", "completion proof"],
    termsAccepted: true,
    termsVersion: PARTNER_TERMS_VERSION,
    privacyAccepted: true,
    privacyVersion: PARTNER_PRIVACY_VERSION,
  };
}

describe("partner portal onboarding completion contracts", () => {
  it("grants limited applicants only the capabilities needed to prepare review requests", () => {
    expect(PARTNER_LIMITED_ACCESS_CAPABILITIES).toEqual(
      expect.arrayContaining([
        "bookings.create",
        "properties.manage",
        "media.upload",
        "proof.request",
      ]),
    );
    for (const forbidden of [
      "account.members.manage",
      "bookings.approve",
      "rates.read",
      "invoices.read",
      "payments.manage",
    ]) {
      expect(PARTNER_LIMITED_ACCESS_CAPABILITIES).not.toContain(forbidden);
    }
  });

  it("accepts bounded current-version applications and normalizes identity", () => {
    const parsed = parsePartnerAccessApplication(validApplication());
    expect(parsed).toEqual(
      expect.objectContaining({
        email: "partner@acme.example",
        companyDomain: "acme.example",
        partnerType: "property_manager",
        termsVersion: PARTNER_TERMS_VERSION,
        privacyVersion: PARTNER_PRIVACY_VERSION,
      }),
    );
    expect(parsed?.phoneE164).toBe("+14105550199");
    const identityHash = partnerApplicationIdentityHash(parsed!.email);
    expect(identityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(identityHash).not.toContain(parsed!.email);
  });

  it("rejects stale consent, unexpected fields, and unbounded arrays", () => {
    expect(
      parsePartnerAccessApplication({
        ...validApplication(),
        termsVersion: "v0-obsolete",
      }),
    ).toBeNull();
    expect(
      parsePartnerAccessApplication({ ...validApplication(), role: "owner" }),
    ).toBeNull();
    expect(
      parsePartnerAccessApplication({
        ...validApplication(),
        serviceAreas: Array.from({ length: 21 }, (_, index) => `Area ${index}`),
      }),
    ).toBeNull();
  });

  it("bounds company join requests and role keys", () => {
    expect(
      parsePartnerJoinRequest({
        accountId: "22222222-2222-4222-8222-222222222222",
        requestedRoleKey: "scheduler",
        message: "I manage this company's properties.",
      }),
    ).toEqual(
      expect.objectContaining({
        accountId: "22222222-2222-4222-8222-222222222222",
        requestedRoleKey: "scheduler",
      }),
    );
    expect(
      parsePartnerJoinRequest({
        accountId: "22222222-2222-4222-8222-222222222222",
        requestedRoleKey: "OWNER; DROP TABLE",
      }),
    ).toBeNull();
  });

  it("enforces browser mutation origins while preserving server adapters", () => {
    expect(
      isAllowedPartnerPortalMutationOrigin(
        new NextRequest("https://api.stonegate.example/api/portal/v2/test", {
          method: "POST",
          headers: { origin: "https://api.stonegate.example" },
        }),
      ),
    ).toBe(true);
    expect(
      isAllowedPartnerPortalMutationOrigin(
        new NextRequest("https://api.stonegate.example/api/portal/v2/test", {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isAllowedPartnerPortalMutationOrigin(
        new NextRequest("https://api.stonegate.example/api/portal/v2/test", {
          method: "POST",
        }),
      ),
    ).toBe(true);
  });

  it("admits the exact configured browser Site origin for the server proxy", () => {
    const previous = process.env["NEXT_PUBLIC_SITE_URL"];
    process.env["NEXT_PUBLIC_SITE_URL"] = "http://localhost:3000";
    try {
      expect(
        isAllowedPartnerPortalMutationOrigin(
          new NextRequest("http://localhost:3001/api/portal/v2/test", {
            method: "POST",
            headers: {
              origin: "http://localhost:3000",
              "sec-fetch-site": "same-site",
            },
          }),
        ),
      ).toBe(true);
      expect(
        isAllowedPartnerPortalMutationOrigin(
          new NextRequest("http://localhost:3001/api/portal/v2/test", {
            method: "POST",
            headers: { origin: "http://localhost:3999" },
          }),
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env["NEXT_PUBLIC_SITE_URL"];
      } else {
        process.env["NEXT_PUBLIC_SITE_URL"] = previous;
      }
    }
  });

  it("uses opaque session handles and canonical company domains", () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const handle = portalV2SessionHandle(sessionId);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(handle).not.toContain(sessionId);
    expect(portalV2SessionHandle(sessionId)).toBe(handle);
    expect(normalizeCompanyDomain("https://www.Acme.Example/path")).toBe(
      "acme.example",
    );
  });

  it("validates notification events, quiet hours, timezone, and SMS intent", () => {
    expect(PARTNER_NOTIFICATION_EVENT_KEYS).toContain("proof_ready");
    expect(
      parsePartnerNotificationPreference({
        eventKey: "proof_ready",
        inAppEnabled: true,
        emailEnabled: true,
        smsEnabled: false,
        quietHoursStart: "21:30",
        quietHoursEnd: "07:00",
        timezone: "America/New_York",
      }),
    ).toEqual(expect.objectContaining({ eventKey: "proof_ready" }));
    expect(
      parsePartnerNotificationPreference({
        eventKey: "unknown_event",
        inAppEnabled: true,
        emailEnabled: true,
        smsEnabled: false,
        quietHoursStart: null,
        quietHoursEnd: null,
        timezone: "Mars/Olympus",
      }),
    ).toBeNull();
  });

  it("keeps every authenticated mutation capability-, origin-, and idempotency-gated", () => {
    const root = join(process.cwd(), "app/api/portal/v2");
    const routes = [
      "access-applications/[applicationId]/withdraw/route.ts",
      "company-join-requests/route.ts",
      "company-join-requests/[requestId]/withdraw/route.ts",
      "sessions/[sessionHandle]/revoke/route.ts",
      "notification-preferences/route.ts",
    ];
    for (const route of routes) {
      const source = readFileSync(join(root, route), "utf8");
      expect(source).toContain("requirePartnerCapability");
      expect(source).toContain("isAllowedPartnerPortalMutationOrigin");
      expect(source).toContain("readPortalV2IdempotencyKey");
    }
  });
});
