import "dotenv/config";
import postgres from "postgres";

const MAX_ATTEMPTS = 60;
const RETRY_DELAY_MS = 1_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPostgres(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set before preparing E2E services.");
  }

  const sql = postgres(databaseUrl, {
    connect_timeout: 2,
    max: 1,
  });
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await sql`select 1`;
        console.info("[e2e] Postgres is ready.");
        return;
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw error;
        await delay(RETRY_DELAY_MS);
      }
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function waitForLocalStack(): Promise<void> {
  const endpoint =
    process.env["LOCALSTACK_ENDPOINT"]?.trim() ?? "http://localhost:4566";
  const healthUrl = new URL("/_localstack/health", endpoint);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        console.info("[e2e] LocalStack is ready.");
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }

  throw new Error("LocalStack did not become ready.");
}

await Promise.all([waitForPostgres(), waitForLocalStack()]);
