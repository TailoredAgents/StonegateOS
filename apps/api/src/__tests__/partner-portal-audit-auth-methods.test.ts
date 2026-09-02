import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { auditLogs, closeDbForTests, getDb } from "@/db";

const ROOT = path.resolve(process.cwd(), "../..");
const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

const AUTH_METHODS = [
  "team_session",
  "break_glass",
  "partner_session",
  "partner_pre_auth",
  "magic_link",
  "password",
  "mfa_step_up",
  "verified_email_session",
  "service",
] as const;

class RollbackAuditMethodTest extends Error {}

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("partner audit authentication-method contract", () => {
  it("keeps the schema and forward migration aligned with every emitted method", () => {
    const schema = source("apps/api/src/db/schema.ts");
    const migration = source(
      "apps/api/src/db/migrations/0146_partner_audit_auth_methods.sql",
    );

    for (const authMethod of AUTH_METHODS) {
      expect(schema).toContain(`'${authMethod}'`);
      expect(migration).toContain(`'${authMethod}'`);
    }
    expect(migration).toContain("VALIDATE CONSTRAINT");
  });
});

describeWithDatabase(
  "partner audit authentication-method PostgreSQL integrity",
  () => {
    afterAll(async () => {
      await closeDbForTests();
    });

    it("accepts the verification-first applicant audit method", async () => {
      const entityId = randomUUID();
      const db = getDb();

      try {
        await db.transaction(async (tx) => {
          await tx.insert(auditLogs).values({
            actorType: "system",
            actorLabel: "verified_partner_applicant",
            authMethod: "verified_email_session",
            action: "partner.access_application.submitted",
            entityType: "partner_access_application",
            entityId,
          });

          const [inserted] = await tx
            .select({ authMethod: auditLogs.authMethod })
            .from(auditLogs)
            .where(eq(auditLogs.entityId, entityId))
            .limit(1);
          expect(inserted?.authMethod).toBe("verified_email_session");

          // Audit records are intentionally append-only. Throwing rolls the
          // test transaction back without weakening that production guarantee.
          throw new RollbackAuditMethodTest();
        });
      } catch (error) {
        if (!(error instanceof RollbackAuditMethodTest)) throw error;
      }
    });
  },
);
