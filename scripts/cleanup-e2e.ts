import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import { ilike, sql } from "drizzle-orm";

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
  const { getDb, contacts, outboxEvents } = await import("../apps/api/src/db");
  const db = getDb();

  const pattern = "e2e+%@mystos.test";
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
