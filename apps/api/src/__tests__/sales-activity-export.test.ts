import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

const mockRequirePermission = jest.fn();
const mockGetDb = jest.fn(() => {
  throw new Error("database must not be reached");
});
const mockRecordAuditEvent = jest.fn();

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/db", () => ({
  auditLogs: {
    id: "audit_logs.id",
    actorType: "audit_logs.actor_type",
    actorId: "audit_logs.actor_id",
    actorRole: "audit_logs.actor_role",
    actorLabel: "audit_logs.actor_label",
    action: "audit_logs.action",
    entityType: "audit_logs.entity_type",
    entityId: "audit_logs.entity_id",
    outcome: "audit_logs.outcome",
    meta: "audit_logs.meta",
    createdAt: "audit_logs.created_at",
  },
  teamMembers: {
    id: "team_members.id",
    name: "team_members.name",
  },
  getDb: mockGetDb,
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: jest.fn(() => ({ id: "actor" })),
  recordAuditEvent: mockRecordAuditEvent,
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: () => true,
}));

import { GET } from "../../app/api/admin/sales/activity/export/route";

function request(query = ""): NextRequest {
  const url = new URL(
    `https://api.example.test/api/admin/sales/activity/export${query}`,
  );
  return {
    nextUrl: url,
    url: url.toString(),
    headers: new Headers(),
  } as unknown as NextRequest;
}

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Sales Activity safe export", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires both sales read and the explicit audit-export capability before work", async () => {
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );

    const response = await GET(request("?limit=not-a-number"));

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.anything(),
      ["sales.read", "audit.export"],
      { mode: "all" },
    );
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["?limit=25", "limit"],
    ["?offset=50", "offset"],
    ["?cursor=screen-page", "cursor"],
    ["?rangeDays=0", "rangeDays"],
    ["?memberId=not-a-uuid", "memberId"],
    ["?unexpected=1", "unexpected"],
  ])("rejects unsafe or ambiguous export filters: %s", async (query, field) => {
    mockRequirePermission.mockResolvedValue(null);

    const response = await GET(request(query));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: "invalid_filter", field }),
    );
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps raw metadata and customer/provider content out of the file contract", () => {
    const api = source("app/api/admin/sales/activity/export/route.ts");
    const proxy = source(
      "../site/src/app/api/team/sales/activity/export/route.ts",
    );
    const ui = source(
      "../site/src/app/team/components/SalesActivityLogSection.tsx",
    );

    expect(api).toContain("publicSalesActivityContext");
    expect(api).not.toContain('"Message body"');
    expect(api).not.toContain('"Recipient"');
    expect(api).not.toContain('"Provider operation ID"');
    expect(api).toContain('action: "sales.activity.exported"');
    expect(api).toContain('action: "sales.activity.export.failed"');
    expect(api).toContain("MAX_SALES_ACTIVITY_EXPORT_EVENTS + 1");
    expect(api).toContain("await recordAuditEvent");
    expect(proxy).toContain('permissions: ["sales.read", "audit.export"]');
    expect(proxy).toContain('permissionMode: "all"');
    expect(proxy).toContain("MAX_EXPORT_BYTES");
    expect(proxy).toContain("malformed_sales_activity_export");
    expect(ui).toContain('hasTeamPermission(principal, "audit.export")');
    expect(ui).toContain("Export redacted CSV");
  });
});
