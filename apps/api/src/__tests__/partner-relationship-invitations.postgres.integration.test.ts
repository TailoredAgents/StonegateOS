import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { POST as acceptInvitationRoute } from "../../app/api/portal/v2/invitations/accept/route";
import {
  closeDbForTests,
  getDb,
  outboxEvents,
  partnerAccountInvitations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerAuthChallenges,
  partnerUsers,
  teamMembers,
  teamRoles,
} from "@/db";
import {
  acceptPartnerAccountInvitation,
  createPartnerAccountInvitation,
  mutatePartnerAccountInvitation,
  partnerInvitationDto,
  type PartnerStaffInvitationActor,
} from "@/lib/partner-account-invitations";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import { derivePartnerInvitationActivationToken } from "@/lib/partner-invitation-handoff";
import {
  completePartnerActivation,
  inspectPartnerActivationToken,
} from "@/lib/partner-purpose-auth";
import {
  createPartnerRelationship,
  enablePartnerRelationshipAsStaff,
  invitePartnerAsStaff,
  PartnerWorkflowUpdateSchema,
} from "@/lib/partner-relationship-management";
import type { TeamMutationContext } from "@/lib/team-mutation";
import { requirePartnerSession, revokePartnerSession } from "@/lib/partner-portal-auth";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
const db = () => getDb();
const request = () =>
  new NextRequest(
    "https://stonegate.example/api/portal/v2/onboarding/activation/complete",
    {
      method: "POST",
      headers: {
        origin: "https://stonegate.example",
        "user-agent": "Local PostgreSQL invitation test",
      },
    },
  );
const PASSWORD = "Private local service test passphrase";
async function fixture(existingEmail?: string) {
  const staffId = randomUUID(),
    roleId = randomUUID(),
    email = existingEmail ?? randomUUID() + "@example.test";
  await db()
    .insert(teamRoles)
    .values({
      id: roleId,
      slug: "invitation-test-" + roleId,
      name: "Local invitation test",
      permissions: [
        "partners.accounts.manage",
        "partners.invitations.send",
        "partners.invitations.revoke",
      ],
    });
  await db()
    .insert(teamMembers)
    .values({
      id: staffId,
      roleId,
      name: "Local relationship staff",
      email: staffId + "@example.test",
      active: true,
    });
  const mutation = {
    actor: {
      type: "human",
      id: staffId,
      authMethod: "team_session",
      sessionId: randomUUID(),
      label: staffId + "@example.test",
    },
    correlationId: "invitation-local-" + randomUUID(),
    idempotencyKeyHash: "a".repeat(64),
  } as TeamMutationContext;
  const result = await db().transaction((tx) =>
    createPartnerRelationship(tx, mutation, {
      companyName: "Local relationship " + randomUUID(),
      contactName: "Local invited partner",
      contactEmail: email,
      persona: "other",
      reason: "Existing relationship confirmed for isolated testing.",
    }),
  );
  const [invitation] = await db()
    .select()
    .from(partnerAccountInvitations)
    .where(eq(partnerAccountInvitations.partnerAccountId, result.accountId));
  if (!invitation) throw new Error("fixture_invitation_missing");
  const actor: PartnerStaffInvitationActor = {
    staffIssuer: true,
    accountId: result.accountId,
    teamMemberId: staffId,
    membershipId: null,
    partnerUserId: null,
    email: staffId + "@example.test",
    roleKey: "stonegate",
    session: { id: randomUUID() },
  };
  return {
    accountId: result.accountId,
    invitationId: invitation.id,
    staffId,
    email,
    actor,
    mutation,
  };
}
async function invitation(id: string) {
  const [row] = await db()
    .select()
    .from(partnerAccountInvitations)
    .where(eq(partnerAccountInvitations.id, id));
  if (!row) throw new Error("invitation_missing");
  return row;
}
async function token(id: string) {
  const row = await invitation(id);
  const [event] = await db()
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.id, row.deliveryOutboxEventId!));
  return new URL(
    (event!.payload as { deliveryUrl: string }).deliveryUrl,
  ).searchParams.get("token")!;
}
async function accept(id: string) {
  const raw = await token(id);
  const result = await acceptPartnerAccountInvitation({
    token: raw,
    correlationId: "local-invitation-accept",
  });
  expect(result).not.toBeNull();
  return {
    result: result!,
    activationToken: derivePartnerInvitationActivationToken(raw),
  };
}
async function change(
  f: Awaited<ReturnType<typeof fixture>>,
  action: "resend" | "revoke",
) {
  const row = await invitation(f.invitationId);
  return mutatePartnerAccountInvitation({
    principal: f.actor,
    invitationId: row.id,
    action,
    ifMatch: partnerInvitationDto(row)["etag"] as string,
    correlationId: "local-invitation-change",
    idempotencyKeyHash: "b".repeat(64),
  });
}

// Committed fixtures are deliberately retained only in the disposable localhost
// database, so independent concurrent connections exercise real row locks.
suite("relationship invitations / real PostgreSQL", () => {
  beforeAll(() => {
    process.env["PUBLIC_SITE_URL"] = "https://stonegate.example";
  });
  afterAll(async () => closeDbForTests());
  it("reports unavailable invitation configuration honestly and rolls back company setup", async () => {
    const f = await fixture();
    const saved = { node: process.env["NODE_ENV"], site: process.env["SITE_URL"], publicSite: process.env["NEXT_PUBLIC_SITE_URL"] };
    const companyName = "Failed local invitation configuration " + randomUUID();
    try {
      process.env["NODE_ENV"] = "production";
      process.env["SITE_URL"] = "http://localhost:3110";
      process.env["NEXT_PUBLIC_SITE_URL"] = "http://localhost:3000";
      await expect(db().transaction((tx) => createPartnerRelationship(tx, f.mutation, {
        companyName, contactName: "Local contact", contactEmail: randomUUID() + "@example.test", persona: "other",
        reason: "Local failure containment verification only.",
      }))).rejects.toMatchObject({ status: 503, code: "internal", retryable: true });
      expect(await db().select({ id: partnerAccounts.id }).from(partnerAccounts).where(eq(partnerAccounts.name, companyName))).toHaveLength(0);
      await expect(db().transaction((tx) => invitePartnerAsStaff(tx, f.mutation, {
        accountId: f.accountId, invitation: { email: randomUUID() + "@example.test", name: "Local additional contact", roleKey: "administrator",
          persona: "other", accessLevel: "account", locationIds: [], costCenterIds: [] },
      }))).rejects.toMatchObject({ status: 503, code: "internal", retryable: true });
      expect(await db().select({ id: partnerAccountInvitations.id }).from(partnerAccountInvitations)
        .where(eq(partnerAccountInvitations.partnerAccountId, f.accountId))).toHaveLength(1);
    } finally {
      for (const [key, value] of [["NODE_ENV", saved.node], ["SITE_URL", saved.site], ["NEXT_PUBLIC_SITE_URL", saved.publicSite]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  it("creates only an approved company and one invitation before the recipient opens it", async () => {
    const f = await fixture();
    expect(
      await db()
        .select()
        .from(partnerUsers)
        .where(eq(partnerUsers.normalizedEmail, f.email)),
    ).toHaveLength(0);
    const row = await invitation(f.invitationId);
    expect(row.invitedByTeamMemberId).toBe(f.staffId);
    expect(row.invitedByMembershipId).toBeNull();
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    const accepted = await accept(f.invitationId);
    expect(accepted.result.deliveryStatus).toBe("ready");
    const [challenge] = await db()
      .select()
      .from(partnerAuthChallenges)
      .where(eq(partnerAuthChallenges.invitationId, row.id));
    expect(challenge!.invitationGeneration).toBe(1);
    expect(
      challenge!.expiresAt.getTime() - challenge!.createdAt.getTime(),
    ).toBe(30 * 60 * 1000);
    expect(challenge!.tokenHash).not.toBe(accepted.activationToken);
    const events = await db()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "partner.auth.purpose.email"));
    expect(
      events.filter((event) =>
        JSON.stringify(event.payload).includes(challenge!.id),
      ),
    ).toHaveLength(0);
  });
  it("completes one password step and cannot resend or revoke an activated member", async () => {
    const f = await fixture(),
      a = await accept(f.invitationId);
    expect((await inspectPartnerActivationToken(a.activationToken)).kind).toBe(
      "success",
    );
    const completed = await completePartnerActivation({
      rawToken: a.activationToken,
      password: PASSWORD,
      rememberMe: false,
      correlationId: "local-activation-complete",
      request: request(),
    });
    expect(completed.kind).toBe("success");
    if (completed.kind !== "success") throw Error("Expected a usable activation session");
    const authenticatedRequest = new NextRequest("https://stonegate.example/api/portal/v2/me", {
      headers: { authorization: `Bearer ${completed.sessionToken}` },
    });
    expect(await requirePartnerSession(authenticatedRequest)).toMatchObject({
      ok: true, session: { activePartnerAccountId: f.accountId, authMethod: "password" },
    });
    await revokePartnerSession(completed.sessionToken);
    expect(await requirePartnerSession(authenticatedRequest)).toMatchObject({ ok: false, status: 401 });
    expect((await invitation(f.invitationId)).activatedAt).not.toBeNull();
    expect((await change(f, "resend")).status).toBe(409);
    expect((await change(f, "revoke")).status).toBe(409);
    expect((await inspectPartnerActivationToken(a.activationToken)).kind).toBe(
      "invalid",
    );
  });
  it("revokes opened setup and resends into the same still-invited membership", async () => {
    const f = await fixture(),
      first = await accept(f.invitationId);
    expect((await change(f, "revoke")).status).toBe(200);
    expect(
      (await inspectPartnerActivationToken(first.activationToken)).kind,
    ).toBe("invalid");
    expect((await change(f, "resend")).status).toBe(202);
    const second = await accept(f.invitationId);
    expect(second.result.membershipId).toBe(first.result.membershipId);
    expect(second.activationToken).not.toBe(first.activationToken);
    expect(
      await db()
        .select()
        .from(partnerAccountMemberships)
        .where(eq(partnerAccountMemberships.partnerAccountId, f.accountId)),
    ).toHaveLength(1);
    expect(
      (
        await completePartnerActivation({
          rawToken: second.activationToken,
          password: PASSWORD,
          rememberMe: false,
          correlationId: "local-resumed-activation",
          request: request(),
        })
      ).kind,
    ).toBe("success");
  });
  it("invalidates unfinished setup when the issuer loses access or the account is disabled", async () => {
    const first = await fixture(),
      a = await accept(first.invitationId);
    await db()
      .update(teamMembers)
      .set({ active: false })
      .where(eq(teamMembers.id, first.staffId));
    expect((await inspectPartnerActivationToken(a.activationToken)).kind).toBe(
      "invalid",
    );
    const second = await fixture(),
      b = await accept(second.invitationId);
    await db()
      .update(partnerAccounts)
      .set({ portalAccessEnabled: false })
      .where(eq(partnerAccounts.id, second.accountId));
    expect((await inspectPartnerActivationToken(b.activationToken)).kind).toBe(
      "invalid",
    );
  });
  it("allows only one consumer and rejects cross-account invitation substitution", async () => {
    const f = await fixture(),
      raw = await token(f.invitationId);
    const accepted = await Promise.all(
      [1, 2].map(() =>
        acceptPartnerAccountInvitation({
          token: raw,
          correlationId: "local-concurrent-invitation",
        }),
      ),
    );
    expect(accepted.filter(Boolean)).toHaveLength(1);
    const other = await fixture(),
      row = await invitation(f.invitationId);
    const result = await mutatePartnerAccountInvitation({
      principal: other.actor,
      invitationId: row.id,
      action: "revoke",
      ifMatch: partnerInvitationDto(row)["etag"] as string,
      correlationId: "local-tenant-substitution",
      idempotencyKeyHash: "c".repeat(64),
    });
    expect(result.status).toBe(404);
  });
  it("retries a lost invitation handoff without replaying stale authority or creating another membership", async () => {
    const f = await fixture(),
      raw = await token(f.invitationId);
    const submit = () =>
      acceptInvitationRoute(
        new NextRequest(
          "https://stonegate.example/api/portal/v2/invitations/accept",
          {
            method: "POST",
            headers: {
              origin: "https://stonegate.example",
              "content-type": "application/json",
              "idempotency-key": "local-invite-retry-" + f.invitationId,
            },
            body: JSON.stringify({ token: raw }),
          },
        ),
      );
    const first = await submit(),
      retry = await submit();
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    const a: unknown = await first.json(),
      b: unknown = await retry.json();
    if (!a || typeof a !== "object" || !("activationExpiresAt" in a) || !b || typeof b !== "object" || !("activationExpiresAt" in b)) throw Error("Missing activation expiry in invitation response");
    expect(a.activationExpiresAt).toBe(b.activationExpiresAt);
    for (const body of [a, b]) {
      expect(body).not.toHaveProperty("sessionToken");
      expect(body).not.toHaveProperty("activationToken");
    }
    expect(
      await db()
        .select()
        .from(partnerAccountMemberships)
        .where(eq(partnerAccountMemberships.partnerAccountId, f.accountId)),
    ).toHaveLength(1);
    expect((await change(f, "revoke")).status).toBe(200);
    expect((await submit()).status).toBe(401);
  });
  it("requires explicit recurring-template dependencies and never selects a role implicitly", () => {
    const config = {
      tools: {
        templates: false,
        recurring: true,
        bulk: false,
        reports: false,
        portfolio: false,
        approvals: false,
      },
      requestableServiceKeys: [],
      disabledServiceKeys: [],
      partialPayments: false,
    };
    expect(PartnerWorkflowUpdateSchema.safeParse(config).success).toBe(false);
    expect(
      PartnerWorkflowUpdateSchema.safeParse({
        ...config,
        tools: { ...config.tools, templates: true },
      }).success,
    ).toBe(true);
  });
  it("uses an existing identity's current password once without resetting it or losing another company", async () => {
    const first = await fixture(),
      a = await accept(first.invitationId);
    expect(
      (
        await completePartnerActivation({
          rawToken: a.activationToken,
          password: PASSWORD,
          rememberMe: false,
          correlationId: "local-first-company",
          request: request(),
        })
      ).kind,
    ).toBe("success");
    const [before] = await db()
      .select()
      .from(partnerUsers)
      .where(eq(partnerUsers.normalizedEmail, first.email));
    const second = await fixture(first.email),
      b = await accept(second.invitationId);
    expect(
      await inspectPartnerActivationToken(b.activationToken),
    ).toMatchObject({ kind: "success", passwordAlreadySet: true });
    expect(
      (
        await completePartnerActivation({
          rawToken: b.activationToken,
          password: "wrong current password",
          rememberMe: false,
          correlationId: "local-wrong-password",
          request: request(),
        })
      ).kind,
    ).toBe("password_incorrect");
    expect((await inspectPartnerActivationToken(b.activationToken)).kind).toBe(
      "success",
    );
    expect(
      (
        await completePartnerActivation({
          rawToken: b.activationToken,
          password: PASSWORD,
          rememberMe: false,
          correlationId: "local-second-company",
          request: request(),
        })
      ).kind,
    ).toBe("success");
    const [after] = await db()
      .select()
      .from(partnerUsers)
      .where(eq(partnerUsers.id, before!.id));
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.securityVersion).toBe(before!.securityVersion);
    expect(
      await db()
        .select()
        .from(partnerAccountMemberships)
        .where(
          and(
            eq(partnerAccountMemberships.partnerUserId, before!.id),
            eq(partnerAccountMemberships.status, "active"),
          ),
        ),
    ).toHaveLength(2);
  });
  it("lets an approved company Administrator invite coworkers and rechecks suspended issuers", async () => {
    const f = await fixture(),
      a = await accept(f.invitationId);
    await completePartnerActivation({
      rawToken: a.activationToken,
      password: PASSWORD,
      rememberMe: false,
      correlationId: "local-company-admin",
      request: request(),
    });
    const [member] = await db()
      .select()
      .from(partnerAccountMemberships)
      .where(eq(partnerAccountMemberships.id, a.result.membershipId));
    const principal = {
      accountId: f.accountId,
      membershipId: member!.id,
      partnerUserId: member!.partnerUserId,
      email: f.email,
      roleKey: "administrator",
      session: { id: randomUUID() },
    } as PartnerPrincipal;
    const created = await createPartnerAccountInvitation({
      principal,
      payload: {
        name: "Local coworker",
        email: randomUUID() + "@example.test",
        roleKey: "operations",
        persona: "other",
        accessLevel: "account",
        locationIds: [],
        costCenterIds: [],
      },
      correlationId: "local-admin-invite",
      idempotencyKeyHash: "d".repeat(64),
    });
    expect(created.status).toBe(202);
    const invitedId = (created.body["invitation"] as { id: string }).id;
    const b = await accept(invitedId);
    await db()
      .update(partnerUsers)
      .set({ active: false, identityStatus: "suspended" })
      .where(eq(partnerUsers.id, member!.partnerUserId));
    expect((await inspectPartnerActivationToken(b.activationToken)).kind).toBe(
      "invalid",
    );
  });
  it("serializes activation versus resend so old setup cannot activate after resend commits", async () => {
    const f = await fixture(),
      a = await accept(f.invitationId);
    const [resend, completion] = await Promise.allSettled([
      change(f, "resend"),
      completePartnerActivation({
        rawToken: a.activationToken,
        password: PASSWORD,
        rememberMe: false,
        correlationId: "local-resend-race",
        request: request(),
      }),
    ]);
    const row = await invitation(f.invitationId);
    if (resend.status === "fulfilled" && resend.value.status === 202) {
      expect(row.status).toBe("pending");
      expect(
        (await inspectPartnerActivationToken(a.activationToken)).kind,
      ).toBe("invalid");
      const [member] = await db()
        .select()
        .from(partnerAccountMemberships)
        .where(eq(partnerAccountMemberships.id, a.result.membershipId));
      expect(member!.status).toBe("invited");
    } else {
      expect(
        completion.status === "fulfilled" &&
          completion.value.kind === "success",
      ).toBe(true);
      expect(row.activatedAt).not.toBeNull();
    }
  });
  it("enables only an active existing relationship and requires its first Administrator explicitly", async () => {
    const f = await fixture(),
      existingId = randomUUID();
    await db().insert(partnerAccounts).values({
      id: existingId,
      name: "Existing CRM company",
      normalizedName: existingId,
      portalAccessEnabled: false,
    });
    const mutation = { ...f.mutation, expectedVersion: "1" };
    expect(
      (
        await db().transaction((tx) =>
          enablePartnerRelationshipAsStaff(tx, mutation, existingId),
        )
      ).version,
    ).toBe("2");
    await expect(
      db().transaction((tx) =>
        invitePartnerAsStaff(tx, mutation, {
          accountId: existingId,
          invitation: {
            name: "First contact",
            email: randomUUID() + "@example.test",
            persona: "other",
            roleKey: "viewer",
            accessLevel: "account",
            locationIds: [],
            costCenterIds: [],
          },
        }),
      ),
    ).rejects.toThrow("first company contact");
    expect(
      await db()
        .select()
        .from(partnerAccountMemberships)
        .where(eq(partnerAccountMemberships.partnerAccountId, existingId)),
    ).toHaveLength(0);
  });
});
