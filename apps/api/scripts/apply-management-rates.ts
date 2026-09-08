import { parseArgs } from "node:util";
import { getDb } from "../src/db";
import { applyManagementRateVersion } from "../src/lib/apply-management-rate-version";

// Credentials come only from the process environment. Never print the URL.
const { values } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    "effective-from": { type: "string" },
    actor: { type: "string" },
    reason: { type: "string" },
    recipient: { type: "string", multiple: true },
  },
});
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLLBACK = new Error("management_rate_dry_run_rollback");
async function main() {
  if (
    !values.actor ||
    !uuid.test(values.actor) ||
    !values["effective-from"] ||
    !values.reason ||
    !values.recipient?.length
  ) {
    throw new Error(
      "Provide --effective-from RFC3339 --actor UUID --reason TEXT and --recipient UUID:BASIS_POINTS for every recipient; --execute commits, otherwise rolls back.",
    );
  }
  const recipients = values.recipient.map((value) => {
    const [memberId, rate] = value.split(":");
    if (!memberId || !uuid.test(memberId) || !rate || !/^\d{1,5}$/u.test(rate))
      throw new Error("invalid_recipient_argument");
    return { memberId, rateBps: Number(rate) };
  });
  let result:
    | Awaited<ReturnType<typeof applyManagementRateVersion>>
    | undefined;
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`set local lock_timeout = '10s'`,
      );
      result = await applyManagementRateVersion(tx, {
        effectiveFrom: new Date(values["effective-from"]!),
        actorId: values.actor!,
        reason: values.reason!,
        recipients,
      });
      if (!values.execute) throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  console.log(
    JSON.stringify({ committed: values.execute, ...result }, null, 2),
  );
}
void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    // DB driver errors can contain connection details: report only a safe name/code.
    console.error(
      "management_rate_change_failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    process.exit(1);
  });
