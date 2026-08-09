import fs from "node:fs";
import path from "node:path";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { encodeAuditCursor, parseAuditQuery } from "@/lib/audit-query";

const API_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");

function apiSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function repoSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relativePath), "utf8");
}

describe("audit log integrity", () => {
  it("redacts credentials and unnecessary PII while preserving safe evidence", () => {
    const longArray = Array.from({ length: 55 }, (_, index) => index);
    const result = sanitizeAuditMetadata({
      contactId: "contact-123",
      providerOperationId: "provider-456",
      password: "do-not-store",
      nested: {
        access_token: "secret-token",
        email: "customer@example.com",
        from: "+15555550124",
        name: "Customer Name",
        phoneE164: "+15555550123",
        messageBody: "private message",
        toAddress: "recipient@example.com",
        outcome: "succeeded",
      },
      longArray,
    });

    expect(result).toMatchObject({
      contactId: "contact-123",
      providerOperationId: "provider-456",
      password: "[REDACTED]",
      nested: {
        access_token: "[REDACTED]",
        email: "[REDACTED_PII]",
        from: "[REDACTED_PII]",
        name: "[REDACTED_PII]",
        phoneE164: "[REDACTED_PII]",
        messageBody: "[REDACTED_PII]",
        toAddress: "[REDACTED_PII]",
        outcome: "succeeded",
      },
    });
    expect(result?.["longArray"]).toHaveLength(51);
  });

  it("parses date boundaries and rejects filters that could broaden an export", () => {
    const cursor = encodeAuditCursor({
      createdAt: "2026-08-08T12:00:00.000Z",
      id: "123e4567-e89b-42d3-a456-426614174000",
    });
    const parsed = parseAuditQuery(
      new URLSearchParams({
        from: "2026-08-01",
        to: "2026-08-08",
        outcome: "succeeded",
        cursor,
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      query: {
        outcome: "succeeded",
        cursor: { id: "123e4567-e89b-42d3-a456-426614174000" },
      },
    });
    if (parsed.ok) {
      expect(parsed.query.from?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
      expect(parsed.query.to?.toISOString()).toBe("2026-08-09T00:00:00.000Z");
    }

    expect(
      parseAuditQuery(new URLSearchParams({ action: "x".repeat(161) })),
    ).toMatchObject({ ok: false, field: "action" });
    expect(
      parseAuditQuery(new URLSearchParams({ cursor }), {
        allowCursor: false,
      }),
    ).toMatchObject({ ok: false, field: "cursor" });
  });

  it("stores verified attribution in dedicated columns and sanitizes both writers", () => {
    const schema = apiSource("src/db/schema.ts");
    const audit = apiSource("src/lib/audit.ts");
    const mutation = apiSource("src/lib/team-mutation.ts");

    for (const column of [
      'sessionId: uuid("session_id")',
      'authMethod: text("auth_method")',
      'correlationId: text("correlation_id")',
      'requiredPermissions: text("required_permissions").array()',
      'outcome: text("outcome")',
      'providerOperationId: text("provider_operation_id")',
      'idempotencyKeyHash: varchar("idempotency_key_hash"',
    ]) {
      expect(schema).toContain(column);
    }
    expect(audit).toContain("sanitizeAuditMetadata(input.meta)");
    expect(audit).toContain("sessionId: actor.sessionId ?? null");
    expect(audit).toContain("authMethod: actor.authMethod ?? null");
    expect(mutation).toContain("sanitizeAuditMetadata({");
    expect(mutation).toContain("correlationId: mutation.correlationId");
    expect(mutation).toContain(
      "requiredPermissions: mutation.policy.requiredPermissions",
    );
  });

  it("registers an expand-first scrub followed by an append-only database guard", () => {
    const migration = apiSource(
      "src/db/migrations/0071_audit_log_integrity.sql",
    );
    const journal = JSON.parse(
      apiSource("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const relationshipIndex = entries.findIndex(
      (entry) => entry.tag === "0070_instant_quote_relationships",
    );

    expect(entries.slice(relationshipIndex, relationshipIndex + 2)).toEqual([
      expect.objectContaining({
        idx: 67,
        tag: "0070_instant_quote_relationships",
      }),
      expect.objectContaining({ idx: 68, tag: "0071_audit_log_integrity" }),
    ]);
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS "audit_logs_actor_id_team_members_id_fk"',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS "audit_logs_actor_id_fkey"',
    );
    expect(migration).toContain('SET "meta" = "meta" - ARRAY[');
    expect(migration).toContain("prevent_audit_log_mutation");
    expect(migration).toContain("BEFORE UPDATE OR DELETE OR TRUNCATE");
    expect(migration).toContain("FOR EACH STATEMENT");
    expect(migration).toContain('ALTER COLUMN "outcome" SET NOT NULL');
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"audit_logs"/iu);
  });

  it("repairs the legacy inline actor FK without mutating audit history", () => {
    const repair = apiSource(
      "src/db/migrations/0093_audit_actor_fk_cleanup.sql",
    );
    const journal = JSON.parse(
      apiSource("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };

    expect(repair).toContain(
      'DROP CONSTRAINT IF EXISTS "audit_logs_actor_id_fkey"',
    );
    expect(repair).toContain(
      'DROP CONSTRAINT IF EXISTS "audit_logs_actor_id_team_members_id_fk"',
    );
    expect(repair).toContain(
      "constraint_row.confrelid = 'team_members'::regclass",
    );
    expect(repair).toContain("attribute.attname = 'actor_id'");
    expect(repair).not.toMatch(/UPDATE\s+"audit_logs"/iu);
    expect(repair).not.toMatch(/DELETE\s+FROM\s+"audit_logs"/iu);
    expect(journal.entries).toContainEqual({
      idx: 90,
      version: "7",
      when: 1788912000000,
      tag: "0093_audit_actor_fk_cleanup",
      breakpoints: true,
    });
  });

  it("uses stable cursor pagination and validates filters after authorization", () => {
    const route = apiSource("app/api/admin/audit/route.ts");
    const query = apiSource("src/lib/audit-query.ts");
    const authIndex = route.indexOf('requirePermission(request, "audit.read")');
    const paramsIndex = route.indexOf("const { searchParams }", authIndex);

    expect(authIndex).toBeGreaterThan(-1);
    expect(paramsIndex).toBeGreaterThan(authIndex);
    expect(route).toContain("parseAuditQuery(searchParams)");
    expect(query).toContain("decodeAuditCursor(cursorRaw)");
    expect(query).toContain("buildAuditWhere");
    expect(route).toContain(
      ".orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))",
    );
    expect(route).toContain(".limit(query.limit + 1)");
    expect(route).toContain("sanitizeAuditMetadata(row.meta)");
    expect(route).toContain("retention: AUDIT_RETENTION_POLICY");
    expect(route).toContain('error: "invalid_filter"');
    expect(route).not.toContain(".offset(");
    expect(route).not.toContain("count(*)");
  });

  it("renders truthful errors, filters, accessible detail, and older-event navigation", () => {
    const section = repoSource(
      "apps/site/src/app/team/components/AuditLogSection.tsx",
    );
    const loaders = repoSource("apps/site/src/app/team/surface-loaders.tsx");
    const page = repoSource("apps/site/src/app/team/page.tsx");

    expect(section).toContain('aria-label="Filter audit events"');
    expect(section).toContain('role="alert"');
    expect(section).toContain("No audit events match these filters.");
    expect(section).toContain("Event details");
    expect(section).toContain("View older events");
    expect(section).toContain(
      "Sensitive message and contact data is redacted.",
    );
    expect(section).toContain("Related request events");
    expect(section).toContain("All events for this record");
    expect(section).toContain("Retention: online indefinitely");
    expect(section).toContain("Safe before and after change summary");
    expect(section).toContain("Change summary");
    expect(section).toContain("Open originating surface");
    expect(section).toContain("Open affected record");
    expect(loaders).toContain("<AuditLogSection {...context.audit} />");
    expect(page).toContain("correlationId: params.auditCorrelationId");
  });

  it("exports only redacted, bounded evidence under a separate permission", () => {
    const sdk = repoSource("packages/sdk/src/team-contracts.ts");
    const apiRoute = apiSource("app/api/admin/audit/export/route.ts");
    const siteRoute = repoSource(
      "apps/site/src/app/api/team/audit/export/route.ts",
    );
    const section = repoSource(
      "apps/site/src/app/team/components/AuditLogSection.tsx",
    );

    expect(sdk).toContain('"audit.export"');
    expect(apiRoute).toContain('requirePermission(request, "audit.export")');
    expect(apiRoute).toContain("MAX_EXPORT_EVENTS = 5_000");
    expect(apiRoute).toContain("sanitizeAuditMetadata(row.meta)");
    expect(apiRoute).toContain('action: "audit.exported"');
    expect(apiRoute).toContain('action: "audit.export.failed"');
    expect(apiRoute).toContain("status: 413");
    expect(siteRoute).toContain('permissions: "audit.export"');
    expect(section).toContain("Export redacted JSONL");
    expect(section).toContain('hasTeamPermission(principal, "audit.export")');
  });
});
