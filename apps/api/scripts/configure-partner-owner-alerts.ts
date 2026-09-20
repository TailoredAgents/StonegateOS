/** Audited deployment setup. Defaults to read-only; a test is queued once per release key. */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, getDb, teamMembers } from "../src/db";
import {
  changeOwnerAlertSettings,
  ownerAlertSettingsDto,
  queueOwnerAlertTest,
} from "../src/lib/partner-owner-alerts";

let database: ReturnType<typeof getDb> | undefined;

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) =>
    args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  const ownerId = value("--owner-id"),
    suffix = value("--phone-last-four"),
    releaseKey = value("--release-key");
  const execute = args.includes("--execute"),
    sendTest = args.includes("--send-test");
  if (
    !/^[0-9a-f-]{36}$/u.test(ownerId) ||
    !/^\d{4}$/u.test(suffix) ||
    !/^[A-Za-z0-9._:-]{8,120}$/u.test(releaseKey) ||
    (sendTest && !execute)
  )
    throw new Error(
      "Use --owner-id=UUID --phone-last-four=NNNN --release-key=KEY, with --execute and optional --send-test.",
    );
  database = getDb();
  const summary = await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('partner-owner-alert-release',0))`,
    );
    const before = await ownerAlertSettingsDto(true, tx);
    const owner = before.owners.find((item) => item.id === ownerId);
    if (!owner?.ready || owner.phoneLastFour !== suffix)
      throw new Error(
        "The selected owner or phone no longer matches the approved recipient.",
      );
    if (
      before.settings.enabled &&
      before.settings.ownerTeamMemberId !== ownerId
    )
      throw new Error(
        "Another owner is already selected; review the active configuration before changing it.",
      );
    if (before.settings.enabled && !before.settings.ready)
      throw new Error(
        "The active recipient or saved phone changed; update the owner alert setting before release.",
      );
    if (!execute)
      return {
        mode: "read_only",
        ownerId,
        phoneLastFour: suffix,
        enabled: before.settings.enabled,
        ready: owner.ready,
      };
    if (
      !before.settings.enabled ||
      before.settings.ownerTeamMemberId !== ownerId
    ) {
      const changed = await changeOwnerAlertSettings(tx, {
        enabled: true,
        ownerTeamMemberId: ownerId,
        expectedVersion: String(before.settings.revision),
      });
      await tx.insert(auditLogs).values({
        actorType: "system",
        actorRole: "deployment",
        actorLabel: "authorized-partner-owner-alert-release",
        authMethod: "service",
        outcome: "succeeded",
        action: "partner_owner_alert.release_settings",
        entityType: "team_member",
        entityId: ownerId,
        meta: {
          releaseKey,
          phoneLastFour: suffix,
          revision: changed.after.revision,
          userAuthorized: true,
        },
      });
    }
    const current = await ownerAlertSettingsDto(true, tx);
    let testOperationId: string | null = null;
    if (sendTest) {
      const existing = await tx
        .select({ meta: auditLogs.meta, entityId: auditLogs.entityId })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "partner_owner_alert.release_test"),
            sql`${auditLogs.meta}->>'releaseKey'=${releaseKey}`,
          ),
        )
        .limit(1);
      if (existing[0]) {
        const meta = existing[0].meta;
        if (
          existing[0].entityId !== ownerId ||
          meta?.["phoneLastFour"] !== suffix
        )
          throw new Error(
            "This release key already belongs to a different test recipient.",
          );
        testOperationId =
          typeof meta?.["operationId"] === "string"
            ? meta["operationId"]
            : null;
        if (!testOperationId)
          throw new Error(
            "An earlier test has an incomplete receipt; investigate before retrying.",
          );
      } else {
        const test = await queueOwnerAlertTest(
          tx,
          ownerId,
          String(current.settings.revision),
        );
        testOperationId = test.operationId;
        await tx.insert(auditLogs).values({
          id: randomUUID(),
          actorType: "system",
          actorRole: "deployment",
          actorLabel: "authorized-partner-owner-alert-release",
          authMethod: "service",
          outcome: "succeeded",
          action: "partner_owner_alert.release_test",
          entityType: "team_member",
          entityId: ownerId,
          meta: {
            releaseKey,
            operationId: test.operationId,
            phoneLastFour: suffix,
            userAuthorized: true,
          },
        });
      }
    }
    // Neither a request, an appointment nor a customer message is created here.
    const [member] = await tx
      .select({ active: teamMembers.active })
      .from(teamMembers)
      .where(eq(teamMembers.id, ownerId));
    if (!member?.active)
      throw new Error("The owner was deactivated during setup.");
    return {
      mode: "applied",
      ownerId,
      phoneLastFour: suffix,
      enabled: current.settings.enabled,
      enabledSince: current.settings.enabledSince,
      revision: current.settings.revision,
      testOperationId,
      testState: testOperationId ? "queued_or_previously_queued" : null,
    };
  });
  console.log(JSON.stringify(summary));
}
main()
  .catch((error) => {
    console.error(
      "Owner alert setup failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (database) await database.$client.end({ timeout: 5 });
  });
