import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const connectionString = process.env["DATABASE_URL"] ?? "";

// Match the SSL detection logic from apps/api/src/db/index.ts
const shouldUseSsl =
  process.env["DATABASE_SSL"] === "true" ||
  /render\.com/.test(connectionString) ||
  /sslmode=require/.test(connectionString);

export default defineConfig({
  schema: "./apps/api/src/db/schema.ts",
  out: "./apps/api/src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
    ...(shouldUseSsl ? {
      ssl: {
        rejectUnauthorized: false
      }
    } : {})
  }
});

