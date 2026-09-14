import { z } from "zod";
import { isPortalRecord } from "./portal-load";
import { parsePartnerSmsEndpoints } from "./notification-endpoints";

const text = z.string();
const nullable = text.nullable();
const date = text.refine((value) => Number.isFinite(Date.parse(value)));
const account = z.object({
  id: text,
  name: text,
  status: text,
  membershipId: text,
  roleKey: text,
  accessLevel: text,
  current: z.boolean(),
  defaultAccount: z.boolean(),
});
const me = z.object({
  ok: z.literal(true),
  partnerUser: z.object({ email: text, name: text, passwordSet: z.boolean() }),
  account: z.object({ id: text, name: text, status: text }),
  membership: z.object({
    id: text,
    roleKey: text,
    accessLevel: text,
    capabilities: z.array(text),
  }),
  accounts: z.array(account),
});
const sessions = z.object({
  ok: z.literal(true),
  sessions: z.array(
    z.object({
      handle: text,
      current: z.boolean(),
      status: z.enum(["active", "expired", "revoked", "retired"]),
      authMethod: text,
      deviceName: nullable,
      userAgent: nullable,
      createdAt: date,
      lastSeenAt: date,
      expiresAt: date,
      revokedAt: date.nullable(),
    }),
  ),
});
const preferences = z.object({
  ok: z.literal(true),
  preferences: z.array(
    z.object({
      eventKey: text,
      inAppEnabled: z.boolean(),
      emailEnabled: z.boolean(),
      smsEnabled: z.boolean(),
      smsOptInVerified: z.boolean(),
      quietHoursStart: nullable,
      quietHoursEnd: nullable,
      timezone: text,
      etag: text,
    }),
  ),
});
const proofDefaults = z.object({
  ok: z.literal(true),
  requirements: z.array(
    z.object({
      id: text.optional(),
      category: z.enum([
        "intake",
        "before",
        "after",
        "completion",
        "issue",
        "document",
      ]),
      required: z.boolean(),
      minimumCount: z.number().int().nonnegative(),
      source: text.optional(),
      updatedAt: date.optional(),
    }),
  ),
});
const contact = z.object({
  name: nullable,
  email: nullable,
  phoneE164: nullable,
});
const profile = z.object({
  ok: z.literal(true),
  profile: z.object({
    id: text,
    organization: z.object({ name: text, website: nullable }),
    serviceContact: contact,
    billing: z
      .object({
        contact,
        address: z.object({
          line1: nullable,
          line2: nullable,
          city: nullable,
          state: nullable,
          postalCode: nullable,
          country: nullable,
        }),
        defaultPoNumber: nullable,
        costCenterGuidance: nullable,
      })
      .nullable(),
    permissions: z.object({
      canEditOrganization: z.boolean(),
      canEditBilling: z.boolean(),
      canViewBilling: z.boolean(),
    }),
    revision: z.number().int(),
    updatedAt: date,
  }),
});
const personal = z.object({
  ok: z.literal(true),
  profile: z.object({ displayName: text, updatedAt: date }),
});
const role = z.object({
  key: text,
  name: text,
  description: text,
  system: z.boolean(),
});
const team = z.object({
  ok: z.literal(true),
  members: z.array(
    z.object({
      id: text,
      user: z.object({ name: text, email: text, active: z.boolean() }),
      role: z.object({ key: text, name: text, description: nullable }),
      status: z.enum(["invited", "active", "suspended", "removed"]),
      persona: text,
      accessLevel: z.enum(["account", "scoped"]),
      currentUser: z.boolean(),
      defaultAccount: z.boolean(),
      dates: z.object({
        invitedAt: date,
        acceptedAt: date.nullable(),
        suspendedAt: date.nullable(),
        updatedAt: date,
      }),
      allowedActions: z.array(
        z.enum(["role_update", "scope_update", "suspend", "reactivate"]),
      ),
      etag: text,
    }),
  ),
  roles: z.array(role),
  invitation: z.object({ available: z.boolean(), reason: nullable }),
  page: z.object({
    limit: z.number(),
    nextCursor: nullable,
    hasMore: z.boolean(),
  }),
});
const invitations = z.object({
  ok: z.literal(true),
  invitations: z.array(
    z.object({
      id: text,
      email: text,
      name: text,
      role: z.object({ key: text }),
      persona: text,
      status: z.enum(["pending", "accepted", "revoked", "expired"]),
      delivery: z.object({
        status: z.enum([
          "queued",
          "dispatching",
          "accepted",
          "failed",
          "reconciliation_required",
        ]),
        sentAt: date.nullable(),
      }),
      expiresAt: date,
      acceptedAt: date.nullable(),
      activatedAt: date.nullable().optional(),
      revokedAt: date.nullable(),
      createdAt: date,
      allowedActions: z.array(z.enum(["resend", "revoke"])),
      etag: text,
    }),
  ),
  scopeOptions: z.object({
    locations: z.array(z.object({ id: text, label: text })),
    costCenters: z.array(z.object({ id: text, label: text })),
    moreResults: z.boolean(),
  }),
  page: z.object({ nextCursor: nullable }),
});
function parser<T>(schema: z.ZodType<T>) {
  return (payload: unknown): T | null => {
    const parsed = schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  };
}
export const parsePortalSettings = parser(me);
export const parsePortalSessions = parser(sessions);
export const parsePortalPreferences = parser(preferences);
export const parsePortalProofDefaults = parser(proofDefaults);
export const parsePortalAccountProfile = parser(profile);
export const parsePortalPersonalProfile = parser(personal);
export const parsePortalTeam = parser(team);
export const parsePortalInvitations = parser(invitations);
export function parsePortalSmsEndpoints(payload: unknown) {
  return isPortalRecord(payload)
    ? parsePartnerSmsEndpoints(payload["endpoints"])
    : null;
}
