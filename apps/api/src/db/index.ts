import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveDatabaseSslOptions } from "./ssl";

declare global {
  var __mystDbClient: ReturnType<typeof postgres> | undefined;
  var __mystDrizzle: ReturnType<typeof drizzle> | undefined;
}

let cachedDb: ReturnType<typeof drizzle> | undefined;

export function getDb() {
  const connectionString = process.env["DATABASE_URL"];

  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const ssl = resolveDatabaseSslOptions(connectionString);

  const client =
    globalThis.__mystDbClient ??
    postgres(connectionString, {
      prepare: false,
      max: 5,
      idle_timeout: 20,
      ...(ssl ? { ssl } : {}),
    });

  if (process.env["NODE_ENV"] !== "production") {
    globalThis.__mystDbClient = client;
  }

  if (!cachedDb) {
    cachedDb = globalThis.__mystDrizzle ?? drizzle(client);

    if (process.env["NODE_ENV"] !== "production") {
      globalThis.__mystDrizzle = cachedDb;
    }
  }

  return cachedDb;
}

/**
 * Close the process-wide database client owned by a test environment.
 *
 * Application code deliberately keeps this pool alive for reuse. Integration
 * suites that import route handlers directly do not have an application
 * lifecycle to close it, so they must explicitly release the client after
 * their final query. Clearing both caches lets a later suite create a fresh
 * connection instead of reusing an ended client.
 */
export async function closeDbForTests(): Promise<void> {
  if (process.env["NODE_ENV"] !== "test") {
    throw new Error("closeDbForTests is only available in test environments");
  }

  const client = globalThis.__mystDbClient;
  cachedDb = undefined;
  globalThis.__mystDrizzle = undefined;
  globalThis.__mystDbClient = undefined;

  if (client) {
    await client.end({ timeout: 5 });
  }
}

export type DatabaseClient = ReturnType<typeof getDb>;

export * from "./schema";
