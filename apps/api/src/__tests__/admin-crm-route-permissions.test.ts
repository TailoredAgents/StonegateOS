import { readFileSync } from "node:fs";
import { join } from "node:path";

type GuardContract = {
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  permission: string;
  requestName?: string;
  mutationBoundary?: boolean;
};

const CONTRACTS: GuardContract[] = [
  {
    path: "app/api/admin/calls/start/route.ts",
    method: "POST",
    permission: "calls.place",
    mutationBoundary: true,
  },
  {
    path: "app/api/admin/canvass/queue/route.ts",
    method: "GET",
    permission: "outbound.read",
  },
  {
    path: "app/api/admin/contacts/route.ts",
    method: "GET",
    permission: "contacts.read",
  },
  {
    path: "app/api/admin/contacts/route.ts",
    method: "POST",
    permission: "contacts.write",
  },
  {
    path: "app/api/admin/contacts/[contactId]/instant-quote-photos/route.ts",
    method: "GET",
    permission: "contacts.read",
  },
  {
    path: "app/api/admin/contacts/[contactId]/media-analysis/rebuild/route.ts",
    method: "POST",
    permission: "contacts.write",
  },
  {
    path: "app/api/admin/contacts/[contactId]/media-analysis/route.ts",
    method: "GET",
    permission: "contacts.read",
  },
  {
    path: "app/api/admin/contacts/[contactId]/omni/route.ts",
    method: "GET",
    permission: "contacts.read",
  },
  {
    path: "app/api/admin/contacts/[contactId]/properties/[propertyId]/route.ts",
    method: "PATCH",
    permission: "properties.write",
  },
  {
    path: "app/api/admin/contacts/[contactId]/properties/[propertyId]/route.ts",
    method: "DELETE",
    permission: "properties.delete",
  },
  {
    path: "app/api/admin/contacts/[contactId]/properties/route.ts",
    method: "POST",
    permission: "properties.write",
  },
  {
    path: "app/api/admin/contacts/[contactId]/route.ts",
    method: "PATCH",
    permission: "contacts.write",
  },
  {
    path: "app/api/admin/contacts/[contactId]/route.ts",
    method: "DELETE",
    permission: "contacts.delete",
    mutationBoundary: true,
  },
  {
    path: "app/api/admin/contacts/[contactId]/restore/route.ts",
    method: "POST",
    permission: "contacts.restore",
    mutationBoundary: true,
  },
  {
    path: "app/api/admin/contacts/[contactId]/sales-agent-memory/rebuild/route.ts",
    method: "POST",
    permission: "contacts.write",
    requestName: "_request",
  },
  {
    path: "app/api/admin/contacts/[contactId]/sales-agent-memory/route.ts",
    method: "GET",
    permission: "contacts.read",
  },
  {
    path: "app/api/admin/contacts/[contactId]/sales-agent-next-action/rebuild/route.ts",
    method: "POST",
    permission: "contacts.write",
  },
  {
    path: "app/api/admin/contacts/[contactId]/sales-agent-next-action/route.ts",
    method: "GET",
    permission: "contacts.read",
  },
  {
    path: "app/api/admin/contacts/[contactId]/sales-agent-next-action/route.ts",
    method: "PATCH",
    permission: "contacts.write",
  },
  {
    path: "app/api/admin/crm/pipeline/[contactId]/route.ts",
    method: "PATCH",
    permission: "pipeline.write",
    mutationBoundary: true,
  },
  {
    path: "app/api/admin/crm/pipeline/audit/route.ts",
    method: "GET",
    permission: "pipeline.read",
  },
  {
    path: "app/api/admin/crm/pipeline/route.ts",
    method: "GET",
    permission: "pipeline.read",
  },
  {
    path: "app/api/admin/crm/reminders/route.ts",
    method: "POST",
    permission: "contacts.write",
    mutationBoundary: true,
  },
  {
    path: "app/api/admin/crm/reminders/[taskId]/route.ts",
    method: "PATCH",
    permission: "contacts.write",
    mutationBoundary: true,
  },
  {
    path: "app/api/admin/crm/reminders/[taskId]/route.ts",
    method: "POST",
    permission: "contacts.write",
    mutationBoundary: true,
  },
  {
    path: "app/api/admin/crm/tasks/[taskId]/route.ts",
    method: "PATCH",
    permission: "contacts.write",
  },
  {
    path: "app/api/admin/crm/tasks/[taskId]/route.ts",
    method: "DELETE",
    permission: "contacts.write",
  },
  {
    path: "app/api/admin/crm/tasks/route.ts",
    method: "GET",
    permission: "contacts.read",
  },
  {
    path: "app/api/admin/crm/tasks/route.ts",
    method: "POST",
    permission: "contacts.write",
  },
  {
    path: "app/api/admin/instant-quotes/[id]/route.ts",
    method: "DELETE",
    permission: "quotes.delete",
    mutationBoundary: true,
  },
  {
    path: "app/api/admin/instant-quotes/route.ts",
    method: "GET",
    permission: "quotes.read",
  },
];

function methodSource(contract: GuardContract): string {
  const source = readFileSync(join(process.cwd(), contract.path), "utf8");
  const marker = `export async function ${contract.method}(`;
  const start = source.indexOf(marker);
  if (start < 0)
    throw new Error(`Missing ${contract.method} in ${contract.path}`);
  const next = source.indexOf("export async function ", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

describe("CRM admin route permission contracts", () => {
  test.each(CONTRACTS)(
    "$method $path requires $permission before parsing or I/O",
    (contract) => {
      const source = methodSource(contract);
      const requestName = contract.requestName ?? "request";
      const permissionGate = contract.mutationBoundary
        ? source.indexOf(`beginTeamMutation(${requestName},`)
        : source.indexOf(
            `requirePermission(${requestName}, "${contract.permission}")`,
          );

      if (contract.mutationBoundary) {
        expect(permissionGate).toBeGreaterThanOrEqual(0);
        const completeRoute = readFileSync(
          join(process.cwd(), contract.path),
          "utf8",
        );
        expect(completeRoute).toContain(
          `requiredPermissions: ["${contract.permission}"]`,
        );
      } else {
        const keyGate = source.indexOf(`isAdminRequest(${requestName})`);
        expect(keyGate).toBeGreaterThanOrEqual(0);
        expect(permissionGate).toBeGreaterThan(keyGate);
      }

      const protectedBoundaries = [
        source.indexOf(`${requestName}.json()`),
        source.indexOf("getDb()"),
        source.indexOf("await context.params"),
        source.indexOf("createTwilioCall("),
      ].filter((index) => index >= 0);

      expect(protectedBoundaries.length).toBeGreaterThan(0);
      expect(permissionGate).toBeLessThan(Math.min(...protectedBoundaries));
    },
  );

  test.each([
    "app/api/admin/contacts/[contactId]/media-analysis/route.ts",
    "app/api/admin/contacts/[contactId]/sales-agent-memory/route.ts",
    "app/api/admin/contacts/[contactId]/sales-agent-next-action/route.ts",
  ])("read-only intelligence GET does not lazily persist data: %s", (path) => {
    const source = methodSource({
      path,
      method: "GET",
      permission: "contacts.read",
    });

    expect(source).not.toMatch(/\bupsert[A-Z]/u);
    expect(source).not.toMatch(/\bbuildMediaJobAnalysisWithVision\b/u);
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(/u);
  });

  test("instant quote deletion commits its audit and replay receipt atomically", () => {
    const source = methodSource({
      path: "app/api/admin/instant-quotes/[id]/route.ts",
      method: "DELETE",
      permission: "quotes.delete",
    });

    expect(source).toContain("db.transaction(");
    expect(source).toMatch(/tx\s*\.delete\(instantQuotes\)/u);
    expect(source).toContain("mutation.audit.insertSuccess(tx");
    expect(source).toContain("completeTeamMutationIdempotency(");
    expect(source).toContain("claimTeamMutationIdempotency(db, mutation");
    expect(source).toContain("teamMutationIdempotencyReplayResponse(");
    expect(source).toContain("mutation.expectedVersion === null");
    expect(source).toContain('auditAction: "instant_quote.deleted"');
    expect(source.indexOf("mutation.audit.insertSuccess(tx")).toBeLessThan(
      source.indexOf("completeTeamMutationIdempotency("),
    );
    expect(source.indexOf("completeTeamMutationIdempotency(")).toBeLessThan(
      source.indexOf("return mutationResult;"),
    );
  });
});
