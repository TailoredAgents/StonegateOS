import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { TEAM_PERMISSION_CATALOG } from "@myst-os/sdk";
import {
  getDb,
  closeDbForTests,
  teamMembers,
  teamRoles,
  partnerAccounts,
  partnerAccountInvitations,
  partnerUsers,
  partnerAccountMemberships,
  outboxEvents,
  partnerAccountLocations,
  teamAuthRateLimits,
  partnerAuthChallenges,
} from "../src/db";
import { hashPassword, loginWithPassword } from "../src/lib/team-auth";

async function main() {
  const endpoint = new URL(process.env["DATABASE_URL"] ?? "http://invalid");
  if (
    process.env["NODE_ENV"] !== "test" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.pathname !== "/portal_access_browser"
  )
    throw Error(
      "Only the disposable local portal_access_browser database is allowed",
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
