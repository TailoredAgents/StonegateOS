/* eslint-disable no-console */
const postgres = require("postgres");

function shouldUseSsl(connectionString) {
  return (
    process.env.DATABASE_SSL === "true" ||
    /render\.com/.test(connectionString) ||
    /sslmode=require/.test(connectionString)
  );
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("[db:migrate] DATABASE_URL not set; skipping drizzle migration sequence fix");
    return;
  }

  const sql = postgres(connectionString, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    ...(shouldUseSsl(connectionString) ? { ssl: { rejectUnauthorized: false } } : {})
  });

  try {
    await sql.unsafe(`
DO $$
DECLARE seq text;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RETURN;
  END IF;

  SELECT pg_get_serial_sequence('drizzle.__drizzle_migrations', 'id') INTO seq;
  IF seq IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format(
    'SELECT setval(%L, (SELECT coalesce(max(id),0) FROM drizzle.__drizzle_migrations))',
    seq
  );
END $$;
`);
    console.log("[db:migrate] drizzle.__drizzle_migrations sequence check complete");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[db:migrate] drizzle migrations sequence fix failed:", error);
  process.exitCode = 1;
});

