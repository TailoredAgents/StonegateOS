import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

const REMOTE_DESTRUCTIVE_ACK = "I_UNDERSTAND_THIS_DELETES_CRM_DATA";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseDatabaseUrl(value: string, source: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `Refusing destructive team audit setup: ${source} is not a valid database URL.`,
    );
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `Refusing destructive team audit setup: ${source} is not PostgreSQL.`,
    );
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error(
      `Refusing destructive team audit setup: ${source} has no database name.`,
    );
  }
  return url;
}

export function assertSafeAuditSeedDatabase(): void {
  const envPath = path.resolve(process.cwd(), ".env.e2e");
  if (!fs.existsSync(envPath)) {
    throw new Error(
      "Refusing destructive team audit setup: .env.e2e is required as the database sentinel.",
    );
  }

  const expectedDatabaseUrl = parse(
    fs.readFileSync(envPath),
  ).DATABASE_URL?.trim();
  const actualDatabaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!expectedDatabaseUrl || !actualDatabaseUrl) {
    throw new Error(
      "Refusing destructive team audit setup: DATABASE_URL must be present in both .env.e2e and the active environment.",
    );
  }
  if (actualDatabaseUrl !== expectedDatabaseUrl) {
    throw new Error(
      "Refusing destructive team audit setup: the active DATABASE_URL does not exactly match .env.e2e.",
    );
  }

  const target = parseDatabaseUrl(actualDatabaseUrl, "DATABASE_URL");
  if (LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) return;

  if (
    process.env["TEAM_AUDIT_REMOTE_DESTRUCTIVE_ACK"] !== REMOTE_DESTRUCTIVE_ACK
  ) {
    throw new Error(
      `Refusing destructive team audit setup for a remote database. Set TEAM_AUDIT_REMOTE_DESTRUCTIVE_ACK=${REMOTE_DESTRUCTIVE_ACK} only for an isolated disposable clone.`,
    );
  }
}
