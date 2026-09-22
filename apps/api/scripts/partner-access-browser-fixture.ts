import { isLocalPartnerRehearsalDatabase } from "../../../scripts/lib/partner-local-rehearsal";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { TEAM_PERMISSION_CATALOG } from "@myst-os/sdk";
import {
  getDb,
  closeDbForTests,
  teamMembers,
  teamRoles,
  partnerAccounts,
  partnerApprovalRules,
  partnerAccountInvitations,
  partnerUsers,
  partnerAccountMemberships,
  outboxEvents,
  partnerAccountLocations,
  teamAuthRateLimits,
  partnerAuthChallenges,
  partnerSchedulingProfiles,
  partnerSchedulingProfileResourceRequirements,
  scheduleResourcePools,
  scheduleResources,
} from "../src/db";
import { hashPassword, loginWithPassword } from "../src/lib/team-auth";

async function main() {
  const endpoint = new URL(process.env["DATABASE_URL"] ?? "http://invalid");
  if (
    process.env["NODE_ENV"] !== "test" ||
    !isLocalPartnerRehearsalDatabase(endpoint)
  )
    throw Error(
      "Only an allowlisted disposable local partner rehearsal database is allowed",
    );
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (typeof value === "string" || value instanceof Uint8Array)
      chunks.push(Buffer.from(value));
    else throw Error("Invalid local fixture input");
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    action: string;
    email?: string;
    accountId?: string;
    invitationId?: string;
    staffId?: string;
  };
  const db = getDb();
  try {
    let output: unknown;
    if (input.action === "staff") {
      // Each browser scenario starts a new isolated rate-limit window. This
      // database is dedicated to this harness; production guards remain active.
      await db.delete(teamAuthRateLimits);
      const id = randomUUID(),
        email = `access-staff-${id}@example.test`,
        password = "Local staff access browser passphrase 2026!";
      await db
        .insert(teamRoles)
        .values({
          name: "Local owner",
          slug: "owner",
          permissions: [...TEAM_PERMISSION_CATALOG],
        })
        // Other isolated permission tests may have intentionally narrowed this
        // canonical role. Restore the browser scenario's explicit fixture.
        .onConflictDoUpdate({
          target: teamRoles.slug,
          set: { permissions: [...TEAM_PERMISSION_CATALOG] },
        });
      const [role] = await db
        .select()
        .from(teamRoles)
        .where(eq(teamRoles.slug, "owner"))
        .limit(1);
      if (!role)
        throw Error("Canonical owner role missing from rehearsal snapshot");
      await db.insert(teamMembers).values({
        id,
        roleId: role.id,
        name: "Local access browser staff",
        email,
        emailNormalized: email,
        emailIdentityStatus: "ready",
        active: true,
        passwordHash: hashPassword(password),
        passwordSetAt: new Date(),
      });
      const session = await loginWithPassword(
        email,
        password,
        new NextRequest("http://127.0.0.1:3111/api/web/team/login"),
        1,
        { correlationId: randomUUID(), surface: "/team/login" },
      );
      if (!session) throw Error("Canonical local staff login failed");
      output = { id, sessionToken: session.sessionToken };
    } else if (input.action === "approval-rule") {
      if (!input.accountId || !input.staffId)
        throw Error("Explicit synthetic account and staff IDs required");
      output = await db.transaction(async (tx) => {
        const [account] = await tx
          .select()
          .from(partnerAccounts)
          .where(eq(partnerAccounts.id, input.accountId!))
          .for("update")
          .limit(1);
        const [staff] = await tx
          .select()
          .from(teamMembers)
          .where(eq(teamMembers.id, input.staffId!))
          .limit(1);
        if (
          !account?.serviceContactEmail?.endsWith("@example.test") ||
          !staff?.active ||
          !staff.email?.endsWith("@example.test")
        )
          throw Error(
            "Only a synthetic company and synthetic staff member may receive this fixture",
          );
        const name = "Local browser painting review";
        const [existing] = await tx
          .select({ id: partnerApprovalRules.id })
          .from(partnerApprovalRules)
          .where(
            and(
              eq(partnerApprovalRules.partnerAccountId, account.id),
              eq(partnerApprovalRules.name, name),
            ),
          )
          .limit(1);
        const [rule] = existing
          ? [existing]
          : await tx
              .insert(partnerApprovalRules)
              .values({
                partnerAccountId: account.id,
                name,
                conditions: { serviceKeys: ["painting"] },
                requiredApproverCapabilities: ["approvals.decide"],
                requiredApproverRoleKeys: [],
                requiredDecisionCount: 1,
                createdByTeamMemberId: staff.id,
              })
              .returning({ id: partnerApprovalRules.id });
        const configured = account.portalWorkflowConfig["tools"];
        const tools =
          configured &&
          typeof configured === "object" &&
          !Array.isArray(configured)
            ? (configured as Record<string, unknown>)
            : {};
        await tx
          .update(partnerAccounts)
          .set({
            portalWorkflowConfig: {
              ...account.portalWorkflowConfig,
              tools: { ...tools, approvals: true },
            },
            portalWorkflowRevision: sql`${partnerAccounts.portalWorkflowRevision} + 1`,
          })
          .where(eq(partnerAccounts.id, account.id));
        const now = new Date();
        const [junkProfile] = await tx
          .select()
          .from(partnerSchedulingProfiles)
          .where(
            and(
              eq(partnerSchedulingProfiles.serviceKey, "junk-removal"),
              eq(partnerSchedulingProfiles.active, true),
              lte(partnerSchedulingProfiles.effectiveFrom, now),
              or(
                isNull(partnerSchedulingProfiles.effectiveTo),
                gt(partnerSchedulingProfiles.effectiveTo, now),
              ),
            ),
          )
          .orderBy(desc(partnerSchedulingProfiles.version))
          .limit(1);
        const requirements = junkProfile
          ? await tx
              .select()
              .from(partnerSchedulingProfileResourceRequirements)
              .where(
                eq(
                  partnerSchedulingProfileResourceRequirements.schedulingProfileId,
                  junkProfile.id,
                ),
              )
          : [];
        if (
          (junkProfile &&
            (junkProfile.capacityPoolKey !== "field_service" ||
              requirements.length === 0)) ||
          requirements.some(
            (requirement) =>
              requirement.resourceKind === "equipment" ||
              requirement.quantity !== 1,
          )
        )
          throw Error(
            "The local journey needs a field-service profile with one crew and truck; preserve the configured profile and adapt the fixture.",
          );
        await tx
          .insert(scheduleResourcePools)
          .values({
            key: "field_service",
            label: "Field service",
            capacityUnits: 8,
            active: true,
          })
          .onConflictDoUpdate({
            target: scheduleResourcePools.key,
            set: {
              capacityUnits: sql`greatest(${scheduleResourcePools.capacityUnits}, 8)`,
              active: true,
            },
          });
        const crews: Array<{ id: string; label: string }> = [];
        let truck: { id: string; label: string } | undefined;
        for (const definition of [
          { kind: "crew", index: 1 },
          { kind: "crew", index: 2 },
          { kind: "truck", index: 1 },
        ] as const) {
          const label = `Local browser ${definition.kind} ${definition.index} ${account.id.slice(0, 8)}`;
          const requirement = requirements.find(
            (item) => item.resourceKind === definition.kind,
          );
          const values = {
            capacityPoolKey: "field_service",
            kind: definition.kind,
            label,
            source: "staff" as const,
            capacityUnits: requirement?.capacityUnits ?? 1,
            active: true,
            skillKeys: requirement?.requiredSkillKeys ?? [],
          };
          const [existingResource] = await tx
            .select()
            .from(scheduleResources)
            .where(eq(scheduleResources.label, label))
            .limit(1);
          if (
            existingResource &&
            (existingResource.source !== "staff" ||
              existingResource.kind !== definition.kind)
          )
            throw Error(
              "Synthetic resource label is bound to an unexpected resource",
            );
          const [resource] = existingResource
            ? await tx
                .update(scheduleResources)
                .set(values)
                .where(eq(scheduleResources.id, existingResource.id))
                .returning({
                  id: scheduleResources.id,
                  label: scheduleResources.label,
                })
            : await tx
                .insert(scheduleResources)
                .values(values)
                .returning({
                  id: scheduleResources.id,
                  label: scheduleResources.label,
                });
          if (!resource)
            throw Error("Synthetic schedule resource was not saved");
          if (definition.kind === "crew") crews.push(resource);
          else truck = resource;
        }
        if (!truck || !crews[0])
          throw Error("Synthetic crew and truck are required");
        return {
          ruleId: rule!.id,
          accountId: account.id,
          crewId: crews[0].id,
          crewLabel: crews[0].label,
          crews,
          truckId: truck.id,
          truckLabel: truck.label,
          junkDurationMinutes: junkProfile?.durationMinutes ?? 120,
          junkTravelBufferMinutes: junkProfile?.travelBufferMinutes ?? 0,
        };
      });
    } else if (input.action === "invitation") {
      if (!input.email?.endsWith("@example.test"))
        throw Error("Synthetic email required");
      const [invitation] = await db
        .select()
        .from(partnerAccountInvitations)
        .where(eq(partnerAccountInvitations.normalizedEmail, input.email))
        .orderBy(desc(partnerAccountInvitations.createdAt))
        .limit(1);
      if (!invitation?.deliveryOutboxEventId)
        throw Error("Queued invitation not found");
      const [outbox] = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.id, invitation.deliveryOutboxEventId));
      const url = new URL(
        (outbox?.payload as { deliveryUrl: string }).deliveryUrl,
      );
      if (
        url.hostname !== "portal-access.example.test" ||
        url.pathname !== "/partners/invitations/accept"
      )
        throw Error("Unexpected local invitation destination");
      url.protocol = "https:";
      url.host = "localhost:3112";
      output = {
        id: invitation.id,
        accountId: invitation.partnerAccountId,
        url: url.toString(),
        status: invitation.status,
        generation: invitation.generation,
        expiresAt: invitation.expiresAt,
      };
    } else if (input.action === "reset") {
      if (!input.email?.endsWith("@example.test"))
        throw Error("Synthetic email required");
      const [challenge] = await db
        .select()
        .from(partnerAuthChallenges)
        .where(
          and(
            eq(partnerAuthChallenges.normalizedEmail, input.email),
            eq(partnerAuthChallenges.purpose, "password_reset"),
          ),
        )
        .orderBy(desc(partnerAuthChallenges.createdAt))
        .limit(1);
      if (!challenge?.deliveryOutboxEventId)
        throw Error("Queued reset not found");
      const [outbox] = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.id, challenge.deliveryOutboxEventId));
      const url = new URL(
        (outbox?.payload as { deliveryUrl: string }).deliveryUrl,
      );
      if (
        url.hostname !== "portal-access.example.test" ||
        url.pathname !== "/partners/reset-password"
      )
        throw Error("Unexpected local reset destination");
      url.protocol = "https:";
      url.host = "localhost:3112";
      output = { url: url.toString(), expiresAt: challenge.expiresAt };
    } else if (input.action === "expire") {
      if (!input.invitationId || !input.accountId)
        throw Error("Explicit fixture IDs required");
      await db
        .update(partnerAccountInvitations)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(
          and(
            eq(partnerAccountInvitations.id, input.invitationId),
            eq(partnerAccountInvitations.partnerAccountId, input.accountId),
          ),
        );
      output = { expired: true };
    } else if (input.action === "snapshot") {
      if (!input.email?.endsWith("@example.test"))
        throw Error("Synthetic email required");
      const users = await db
        .select({ id: partnerUsers.id, status: partnerUsers.identityStatus })
        .from(partnerUsers)
        .where(eq(partnerUsers.normalizedEmail, input.email));
      const memberships = users[0]
        ? await db
            .select({
              id: partnerAccountMemberships.id,
              accountId: partnerAccountMemberships.partnerAccountId,
              role: partnerAccountMemberships.roleKey,
              status: partnerAccountMemberships.status,
            })
            .from(partnerAccountMemberships)
            .where(eq(partnerAccountMemberships.partnerUserId, users[0].id))
        : [];
      output = { users, memberships };
    } else if (input.action === "locations") {
      if (!input.accountId) throw Error("Explicit account required");
      const [account] = await db
        .select({ id: partnerAccounts.id })
        .from(partnerAccounts)
        .where(eq(partnerAccounts.id, input.accountId));
      if (!account) throw Error("Fixture account missing");
      output = await db
        .insert(partnerAccountLocations)
        .values(
          ["Allowed local site", "Restricted local site"].map((siteName) => ({
            partnerAccountId: input.accountId!,
            siteName,
            addressLine1: "1 Local Test Way",
            city: "Atlanta",
            state: "GA",
            postalCode: "30301",
            timezone: "America/New_York",
            onSiteContact: { name: "Local contact", phone: "+14045550100" },
          })),
        )
        .returning({
          id: partnerAccountLocations.id,
          name: partnerAccountLocations.siteName,
        });
    } else throw Error("Unknown fixture action");
    // The browser harness captures this pipe in memory. Do not print credentials
    // or invite URLs to test logs, screenshots, or persisted result files.
    process.stdout.write(JSON.stringify(output));
  } finally {
    await closeDbForTests();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
