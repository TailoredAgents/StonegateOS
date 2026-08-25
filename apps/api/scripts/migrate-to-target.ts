import "dotenv/config";

import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

type MigrationDefinition = JournalEntry & {
  hash: string;
};

type AppliedMigration = {
  id: number;
  hash: string;
  createdAt: string | number | null;
};

type ErrorRecord = Record<string, unknown> & { cause?: unknown };

const MIGRATION_LOCK_NAMESPACE = "stonegateos";
const MIGRATION_LOCK_NAME = "schema_migrations";
const MIGRATION_TAG_PATTERN = /^\d{4}_[a-z0-9_]+$/;

function formatMigrationError(error: unknown): string {
  const chain: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current) &&
    chain.length < 5
  ) {
    seen.add(current);
    const record = current as ErrorRecord;
    const message =
      current instanceof Error
        ? current.message
        : String(record["message"] ?? "");
    const detail: Record<string, unknown> = {
      name:
        current instanceof Error
          ? current.name
          : String(record["name"] ?? "Error"),
      message: message.slice(0, 1_000),
    };

    for (const field of [
      "code",
      "detail",
      "hint",
      "schema_name",
      "table_name",
      "column_name",
      "constraint_name",
      "routine",
    ]) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) {
        detail[field] = value.slice(0, 1_000);
      }
    }
    chain.push(detail);
    current = record.cause;
  }

  if (chain.length === 0) {
    return String(error).slice(0, 1_000);
  }
  return JSON.stringify(chain);
}

function shouldUseSsl(connectionString: string): boolean {
  return (
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com/.test(connectionString) ||
    /sslmode=require/.test(connectionString)
  );
}

function parseArguments(): {
  targetTag: string;
  dryRun: boolean;
  validateFiles: boolean;
} {
  const args = process.argv.slice(2);
  const unknownOptions = args.filter(
    (argument) =>
      argument.startsWith("-") &&
      argument !== "--dry-run" &&
      argument !== "--validate-files",
  );
  if (unknownOptions.length > 0) {
    throw new Error(`Unknown option: ${unknownOptions.join(", ")}`);
  }

  const positional = args.filter((argument) => !argument.startsWith("-"));
  if (positional.length !== 1) {
    throw new Error(
      "Usage: tsx scripts/migrate-to-target.ts <migration-tag|latest> [--dry-run|--validate-files]",
    );
  }
  if (args.includes("--dry-run") && args.includes("--validate-files")) {
    throw new Error("--dry-run and --validate-files cannot be combined");
  }

  return {
    targetTag: positional[0]!,
    dryRun: args.includes("--dry-run"),
    validateFiles: args.includes("--validate-files"),
  };
}

function validateJournal(journal: Journal): void {
  if (journal.dialect !== "postgresql") {
    throw new Error(
      `Expected a PostgreSQL migration journal, received ${journal.dialect}`,
    );
  }
  if (journal.entries.length === 0) {
    throw new Error("Migration journal contains no entries");
  }

  const tags = new Set<string>();
  const timestamps = new Set<number>();
  let previousWhen = -1;

  journal.entries.forEach((entry, index) => {
    if (entry.idx !== index) {
      throw new Error(
        `Migration journal index mismatch for ${entry.tag}: expected ${index}, received ${entry.idx}`,
      );
    }
    if (!MIGRATION_TAG_PATTERN.test(entry.tag)) {
      throw new Error(`Unsafe migration tag in journal: ${entry.tag}`);
    }
    if (!Number.isSafeInteger(entry.when) || entry.when <= previousWhen) {
      throw new Error(
        `Migration timestamps must be unique and strictly increasing at ${entry.tag}`,
      );
    }
    if (tags.has(entry.tag) || timestamps.has(entry.when)) {
      throw new Error(`Duplicate migration journal entry: ${entry.tag}`);
    }

    tags.add(entry.tag);
    timestamps.add(entry.when);
    previousWhen = entry.when;
  });
}

async function loadMigrationDefinitions(
  sourceDirectory: string,
  journal: Journal,
): Promise<MigrationDefinition[]> {
  return Promise.all(
    journal.entries.map(async (entry) => {
      const migrationSql = await readFile(
        join(sourceDirectory, `${entry.tag}.sql`),
        "utf8",
      );
      return {
        ...entry,
        hash: createHash("sha256").update(migrationSql).digest("hex"),
      };
    }),
  );
}

async function readAppliedMigrations(sql: Sql): Promise<AppliedMigration[]> {
  const tableRows = await sql<Array<{ migrationTable: string | null }>>`
    select to_regclass('drizzle.__drizzle_migrations')::text as "migrationTable"
  `;
  if (!tableRows[0]?.migrationTable) {
    return [];
  }

  return sql<AppliedMigration[]>`
    select id, hash, created_at as "createdAt"
    from drizzle.__drizzle_migrations
    order by created_at asc, id asc
  `;
}

function validateAppliedPrefix(
  appliedRows: AppliedMigration[],
  definitions: MigrationDefinition[],
): number {
  if (appliedRows.length === 0) {
    return -1;
  }

  if (appliedRows.length > definitions.length) {
    throw new Error(
      "Database migration history contains more entries than this release artifact",
    );
  }

  for (let index = 0; index < appliedRows.length; index += 1) {
    const applied = appliedRows[index]!;
    const expected = definitions[index]!;
    const createdAt =
      typeof applied.createdAt === "number"
        ? applied.createdAt
        : Number(applied.createdAt);

    if (!Number.isSafeInteger(createdAt)) {
      throw new Error(
        `Database migration row ${applied.id} has an invalid created_at value`,
      );
    }
    if (createdAt !== expected.when) {
      throw new Error(
        `Database migration history is not an exact prefix: expected ${expected.tag} (${expected.when}) at position ${index}, received ${createdAt}`,
      );
    }
    if (applied.hash !== expected.hash) {
      throw new Error(
        `Migration hash mismatch for ${expected.tag}; refusing to continue with a changed migration`,
      );
    }
  }

  return appliedRows.length - 1;
}

async function acquireMigrationLock(sql: Sql): Promise<void> {
  const rows = await sql<Array<{ acquired: boolean }>>`
    select pg_try_advisory_lock(
      hashtext(${MIGRATION_LOCK_NAMESPACE}),
      hashtext(${MIGRATION_LOCK_NAME})
    ) as acquired
  `;
  if (!rows[0]?.acquired) {
    throw new Error(
      "Another database migration is running; retry after it completes",
    );
  }
}

async function releaseMigrationLock(sql: Sql): Promise<void> {
  await sql`
    select pg_advisory_unlock(
      hashtext(${MIGRATION_LOCK_NAMESPACE}),
      hashtext(${MIGRATION_LOCK_NAME})
    )
  `;
}

async function repairMigrationSequence(sql: Sql): Promise<void> {
  const tableRows = await sql<Array<{ migrationTable: string | null }>>`
    select to_regclass('drizzle.__drizzle_migrations')::text as "migrationTable"
  `;
  if (!tableRows[0]?.migrationTable) {
    return;
  }

  const rows = await sql<
    Array<{ sequenceName: string | null; maxId: string | number }>
  >`
    select
      pg_get_serial_sequence(
        'drizzle.__drizzle_migrations',
        'id'
      ) as "sequenceName",
      coalesce(max(id), 0) as "maxId"
    from drizzle.__drizzle_migrations
  `;
  const sequenceName = rows[0]?.sequenceName;
  const maxId = Number(rows[0]?.maxId ?? 0);
  if (!sequenceName) {
    return;
  }
  if (!Number.isSafeInteger(maxId) || maxId < 0) {
    throw new Error("Drizzle migration sequence has an invalid maximum ID");
  }

  if (maxId === 0) {
    await sql`select setval(${sequenceName}::regclass, 1, false)`;
    return;
  }
  await sql`select setval(${sequenceName}::regclass, ${maxId}, true)`;
}

function describePlan(
  target: MigrationDefinition,
  definitions: MigrationDefinition[],
  appliedIndex: number,
): string {
  const pending = definitions.slice(appliedIndex + 1, target.idx + 1);
  const databaseState =
    appliedIndex < 0 ? "clean database" : definitions[appliedIndex]!.tag;
  const pendingDescription =
    pending.length === 0
      ? "no pending migrations"
      : `${pending.length} pending (${pending[0]!.tag} through ${pending[pending.length - 1]!.tag})`;

  return `database=${databaseState}; target=${target.tag}; ${pendingDescription}`;
}

async function prepareTemporaryMigrationDirectory(
  sourceDirectory: string,
  journal: Journal,
  selectedEntries: JournalEntry[],
): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "stonegate-migrations-"),
  );
  try {
    const temporaryMetaDirectory = join(temporaryDirectory, "meta");
    await mkdir(temporaryMetaDirectory, { recursive: true });

    await writeFile(
      join(temporaryMetaDirectory, "_journal.json"),
      `${JSON.stringify(
        {
          ...journal,
          entries: selectedEntries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await Promise.all(
      selectedEntries.map((entry) =>
        cp(
          join(sourceDirectory, `${entry.tag}.sql`),
          join(temporaryDirectory, `${entry.tag}.sql`),
        ),
      ),
    );

    return temporaryDirectory;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const { targetTag, dryRun, validateFiles } = parseArguments();
  const sourceDirectory = fileURLToPath(
    new URL("../src/db/migrations", import.meta.url),
  );
  const journal = JSON.parse(
    await readFile(join(sourceDirectory, "meta/_journal.json"), "utf8"),
  ) as Journal;
  validateJournal(journal);

  const definitions = await loadMigrationDefinitions(sourceDirectory, journal);
  const target =
    targetTag === "latest"
      ? definitions[definitions.length - 1]
      : definitions.find((entry) => entry.tag === targetTag);
  if (!target) {
    throw new Error(`Unknown migration target: ${targetTag}`);
  }
  if (validateFiles) {
    const next = definitions[target.idx + 1];
    console.log(
      `[db:migrate] source validated: target=${target.tag}; selected=${target.idx + 1}; excluded=${definitions.length - target.idx - 1}; next=${next?.tag ?? "none"}`,
    );
    return;
  }

  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(connectionString, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    ...(shouldUseSsl(connectionString)
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  });
  let lockAcquired = false;

  try {
    await acquireMigrationLock(sql);
    lockAcquired = true;

    const appliedRows = await readAppliedMigrations(sql);
    const appliedIndex = validateAppliedPrefix(appliedRows, definitions);
    if (appliedIndex > target.idx) {
      throw new Error(
        `Database is already beyond ${target.tag} at ${definitions[appliedIndex]!.tag}; migrations are forward-only`,
      );
    }

    console.log(
      `[db:migrate] plan: ${describePlan(target, definitions, appliedIndex)}`,
    );
    if (dryRun) {
      console.log("[db:migrate] dry run complete; no migrations were applied");
      return;
    }
    if (appliedIndex === target.idx) {
      console.log(
        `[db:migrate] ${target.tag} is already applied; no changes made`,
      );
      return;
    }

    const selectedEntries = journal.entries.slice(0, target.idx + 1);
    await repairMigrationSequence(sql);
    const temporaryDirectory = await prepareTemporaryMigrationDirectory(
      sourceDirectory,
      journal,
      selectedEntries,
    );

    try {
      await migrate(drizzle(sql), {
        migrationsFolder: temporaryDirectory,
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }

    const verifiedRows = await readAppliedMigrations(sql);
    const verifiedIndex = validateAppliedPrefix(verifiedRows, definitions);
    if (verifiedIndex !== target.idx) {
      throw new Error(
        `Post-migration verification failed: expected ${target.tag}, received ${
          verifiedIndex < 0
            ? "no applied migration"
            : definitions[verifiedIndex]!.tag
        }`,
      );
    }

    console.log(
      `[db:migrate] applied and verified migrations through ${target.tag} (${selectedEntries.length} journal entries)`,
    );
  } finally {
    if (lockAcquired) {
      try {
        await releaseMigrationLock(sql);
      } catch (error) {
        console.error(
          "[db:migrate] failed to release advisory lock cleanly:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(
    `[db:migrate] targeted migration failed: ${formatMigrationError(error)}`,
  );
  process.exitCode = 1;
});
