import fs from "node:fs";
import path from "node:path";

type RouteContract = {
  route: string;
  permission: string;
  firstSensitiveOperation: string;
};

const ROUTE_CONTRACTS: RouteContract[] = [
  {
    route: "db/status/route.ts",
    permission: "access.manage",
    firstSensitiveOperation: "getDb()",
  },
  {
    route: "providers/health/route.ts",
    permission: "access.manage",
    firstSensitiveOperation: "getDb()",
  },
  {
    route: "system/health/route.ts",
    permission: "access.manage",
    firstSensitiveOperation: "inspectSquareConfiguration()",
  },
  {
    route: "revenue/forecast/route.ts",
    permission: "finance.read",
    firstSensitiveOperation: "getDb()",
  },
  {
    route: "schedule/summary/route.ts",
    permission: "appointments.read",
    firstSensitiveOperation: "getDb()",
  },
  {
    route: "plaid/status/route.ts",
    permission: "finance.read",
    firstSensitiveOperation: "plaidConfigured()",
  },
  {
    route: "plaid/link-token/route.ts",
    permission: "payments.manage",
    firstSensitiveOperation: "plaidConfigured()",
  },
  {
    route: "plaid/exchange/route.ts",
    permission: "payments.manage",
    firstSensitiveOperation: "plaidConfigured()",
  },
  {
    route: "plaid/sync/route.ts",
    permission: "payments.manage",
    firstSensitiveOperation: "plaidConfigured()",
  },
  {
    route: "tools/contact/route.ts",
    permission: "contacts.write",
    firstSensitiveOperation: ".json()",
  },
  {
    route: "tools/quote/route.ts",
    permission: "quotes.write",
    firstSensitiveOperation: ".json()",
  },
];

function readAdminRoute(route: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, "../../app/api/admin", route),
    "utf8",
  );
}

describe("admin operational route permission contracts", () => {
  it.each(ROUTE_CONTRACTS)(
    "requires $permission before accessing $route",
    ({ route, permission, firstSensitiveOperation }) => {
      const source = readAdminRoute(route);
      const guardIndex = source.indexOf("requirePermission(");
      const permissionIndex = source.indexOf(`"${permission}"`, guardIndex);
      const sensitiveIndex = source.indexOf(firstSensitiveOperation);

      expect(source).not.toContain("isAdminRequest");
      expect(guardIndex).toBeGreaterThan(-1);
      expect(sensitiveIndex).toBeGreaterThan(-1);
      expect(permissionIndex).toBeGreaterThan(guardIndex);
      expect(permissionIndex).toBeLessThan(sensitiveIndex);
      expect(guardIndex).toBeLessThan(sensitiveIndex);
    },
  );

  it("limits outbox dispatch to the named service-principal path", () => {
    const source = readAdminRoute("outbox/dispatch/route.ts");
    const permissionIndex = source.indexOf(
      'requirePermission(request, "outbox.dispatch")',
    );
    const sourceCheckIndex = source.indexOf(
      'permissionContext.source !== "service"',
    );
    const bodyIndex = source.indexOf("request.json()");

    expect(source).not.toContain("isAdminRequest");
    expect(permissionIndex).toBeGreaterThan(-1);
    expect(sourceCheckIndex).toBeGreaterThan(permissionIndex);
    expect(bodyIndex).toBeGreaterThan(sourceCheckIndex);
  });
});
