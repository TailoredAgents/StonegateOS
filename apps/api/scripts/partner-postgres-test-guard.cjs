/** Prevent a copied deployment DATABASE_URL from turning destructive fixtures into live writes. */
module.exports = async function requireDisposableLocalPartnerDatabase() {
  let database;
  try {
    database = new URL(process.env.DATABASE_URL || "");
  } catch {
    throw new Error(
      "Partner PostgreSQL tests require an explicit disposable local DATABASE_URL.",
    );
  }
  const name = decodeURIComponent(database.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !/^portal_[a-z0-9_]*(?:test|rehearsal|restore|remediation|browser|final)[a-z0-9_]*$/.test(
      name,
    )
  ) {
    throw new Error(
      "Partner PostgreSQL fixtures only run on an explicitly named local portal test/rehearsal database. Live databases are prohibited.",
    );
  }
};
