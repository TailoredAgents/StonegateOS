import "dotenv/config";
import crypto from "node:crypto";
import Module from "node:module";
import path from "node:path";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";

function registerAliases() {
  const mod = Module as unknown as {
    _resolveFilename: Module["_resolveFilename"];
  };
  const originalResolve = mod._resolveFilename.bind(Module);
  mod._resolveFilename = function (request: string, parent, isMain, options) {
    if (request.startsWith("@/")) {
      const absolute = path.resolve("apps/api/src", request.slice(2));
      return originalResolve(absolute, parent, isMain, options);
    }
    if (request.startsWith("@myst-os/")) {
      const [pkg, ...rest] = request.replace("@myst-os/", "").split("/");
      const absolute = path.resolve("packages", pkg, "src", ...rest);
      return originalResolve(absolute, parent, isMain, options);
    }
    return originalResolve(request, parent, isMain, options);
  };
}

async function main() {
  registerAliases();
  const {
    getDb,
    contacts,
    outboxEvents,
    partnerAccountMemberships,
    partnerAccounts,
    partnerAccessApplications,
    partnerMfaMethods,
    partnerSessions,
    partnerUsers,
  } = await import("../apps/api/src/db");
  const db = getDb();

  const pattern = "e2e+%@mystos.test";
  const fixtureContacts = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(ilike(contacts.email, pattern));
  const contactIds = fixtureContacts.map((contact) => contact.id);
  const fixtureUsers = contactIds.length
    ? await db
        .select({ id: partnerUsers.id })
        .from(partnerUsers)
        .where(inArray(partnerUsers.orgContactId, contactIds))
    : [];
  const partnerUserIds = fixtureUsers.map((user) => user.id);
  const outboxDeleted = await db
    .delete(outboxEvents)
    .where(
      sql`payload::text ILIKE '%e2e-%' OR payload::text ILIKE '%@mystos.test%'`,
    )
    .returning({ id: outboxEvents.id });

  const archivedAt = new Date();
  const purgeEligibleAt = new Date(
    archivedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
  );
  let partnerSessionsRevoked = 0;
  let partnerMembershipsSuspended = 0;
  let partnerMfaMethodsDisabled = 0;
  let partnerApplicationsWithdrawn = 0;
  if (partnerUserIds.length) {
    const fixtureSessions = await db
      .select({ id: partnerSessions.id })
      .from(partnerSessions)
      .where(inArray(partnerSessions.partnerUserId, partnerUserIds))
      .orderBy(partnerSessions.id);
    for (const session of fixtureSessions) {
      const archivedSessionHash = crypto
        .createHash("sha256")
        .update(
          `archived-e2e-session:${session.id}:${archivedAt.toISOString()}`,
        )
        .digest("base64url");
      await db
        .update(partnerSessions)
        .set({
          sessionHash: archivedSessionHash,
          revokedAt: archivedAt,
          lastSeenAt: archivedAt,
        })
        .where(eq(partnerSessions.id, session.id));
    }
    partnerSessionsRevoked = fixtureSessions.length;
    const disabledMfa = await db
      .update(partnerMfaMethods)
      .set({ enabled: false, disabledAt: archivedAt, updatedAt: archivedAt })
      .where(
        and(
          inArray(partnerMfaMethods.partnerUserId, partnerUserIds),
          eq(partnerMfaMethods.enabled, true),
        ),
      )
      .returning({ id: partnerMfaMethods.id });
    partnerMfaMethodsDisabled = disabledMfa.length;
    const withdrawnApplications = await db
      .update(partnerAccessApplications)
      .set({
        status: "withdrawn",
        version: sql`${partnerAccessApplications.version} + 1`,
        updatedAt: archivedAt,
      })
      .where(
        and(
          inArray(
            partnerAccessApplications.applicantPartnerUserId,
            partnerUserIds,
          ),
          or(
            eq(partnerAccessApplications.status, "submitted"),
            eq(partnerAccessApplications.status, "under_review"),
            eq(partnerAccessApplications.status, "needs_information"),
          ),
        ),
      )
      .returning({ id: partnerAccessApplications.id });
    partnerApplicationsWithdrawn = withdrawnApplications.length;
    const suspended = await db
      .update(partnerAccountMemberships)
      .set({
        status: "suspended",
        isDefault: false,
        suspendedAt: archivedAt,
        updatedAt: archivedAt,
      })
      .where(
        and(
          inArray(partnerAccountMemberships.partnerUserId, partnerUserIds),
          eq(partnerAccountMemberships.status, "active"),
        ),
      )
      .returning({ id: partnerAccountMemberships.id });
    partnerMembershipsSuspended = suspended.length;
    for (const user of fixtureUsers) {
      await db
        .update(partnerUsers)
        .set({
          email: `archived+${user.id}@e2e.invalid`,
          phone: null,
          phoneE164: null,
          active: false,
          passwordHash: null,
          passwordSetAt: null,
          updatedAt: archivedAt,
        })
        .where(eq(partnerUsers.id, user.id));
    }
  }
  let partnerAccountsDisabled = 0;
  if (contactIds.length) {
    const disabled = await db
      .update(partnerAccounts)
      .set({ portalAccessEnabled: false, updatedAt: archivedAt })
      .where(inArray(partnerAccounts.portalContactId, contactIds))
      .returning({ id: partnerAccounts.id });
    partnerAccountsDisabled = disabled.length;
  }
  const archivedContacts = await db
    .update(contacts)
    .set({
      email: null,
      phone: null,
      phoneE164: null,
      deletedAt: archivedAt,
      deletedBy: null,
      purgeEligibleAt,
      updatedAt: archivedAt,
    })
    .where(ilike(contacts.email, pattern))
    .returning({ id: contacts.id });

  console.log(
    JSON.stringify(
      {
        contactsArchivedForRecovery: archivedContacts.length,
        outboxEventsDeleted: outboxDeleted.length,
        partnerAccountsDisabled,
        partnerApplicationsWithdrawn,
        partnerMembershipsSuspended,
        partnerMfaMethodsDisabled,
        partnerSessionsRevoked,
        partnerUsersDeactivated: fixtureUsers.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
