import fs from "node:fs";
import path from "node:path";
import {
  buildTeamRouteSecurityContract,
  routeIsInTeamSecurityScope,
  TEAM_ROUTE_HTTP_METHODS,
  TEAM_ROUTE_SECURITY_EXEMPTIONS,
  TEAM_ROUTE_SECURITY_MIGRATION_BACKLOG,
  TEAM_ROUTE_SECURITY_ROOTS,
  type TeamRouteHttpMethod,
} from "@/lib/team-route-security-manifest";

type RouteMethodSource = {
  route: string;
  method: TeamRouteHttpMethod;
  fileSource: string;
  methodSource: string;
};

const API_ROOT = path.resolve(__dirname, "../..");
const ROUTE_EXPORT_PATTERN = new RegExp(
  `export\\s+async\\s+function\\s+(${TEAM_ROUTE_HTTP_METHODS.join("|")})\\s*\\(`,
  "gu",
);
const PERMISSION_LITERAL_PATTERN =
  /["']([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)["']/gu;

function listRouteFiles(root: string): string[] {
  const absoluteRoot = path.resolve(API_ROOT, root);
  const stat = fs.statSync(absoluteRoot);
  if (stat.isFile()) return [root];

  const routes: string[] = [];
  const visit = (absoluteDirectory: string): void => {
    for (const entry of fs.readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.name === "route.ts") {
        routes.push(path.relative(API_ROOT, absolutePath));
      }
    }
  };
  visit(absoluteRoot);
  return routes.sort();
}

function readRouteMethods(route: string): RouteMethodSource[] {
  const fileSource = fs.readFileSync(path.resolve(API_ROOT, route), "utf8");
  const matches = [...fileSource.matchAll(ROUTE_EXPORT_PATTERN)];
  return matches.map((match, index) => ({
    route,
    method: match[1] as TeamRouteHttpMethod,
    fileSource,
    methodSource: fileSource.slice(
      match.index,
      matches[index + 1]?.index ?? fileSource.length,
    ),
  }));
}

function requirePermissionCalls(source: string): string[] {
  return functionCalls(source, "requirePermission(");
}

function functionCalls(source: string, marker: string): string[] {
  const calls: string[] = [];
  let searchIndex = 0;
  while (searchIndex < source.length) {
    const start = source.indexOf(marker, searchIndex);
    if (start < 0) break;
    let depth = 1;
    let index = start + marker.length;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    for (; index < source.length && depth > 0; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      }
    }
    calls.push(source.slice(start, index));
    searchIndex = index;
  }
  return calls;
}

function mutationBoundaryPermissions(source: string): string[] {
  return [
    ...new Set(
      functionCalls(source, "beginTeamMutation(").flatMap((call) => {
        const required =
          /requiredPermissions\s*:\s*\[([^\]]*)\]/u.exec(call)?.[1] ?? "";
        return [...required.matchAll(PERMISSION_LITERAL_PATTERN)].map(
          (match) => match[1],
        );
      }),
    ),
  ];
}

function permissionLiterals(source: string): string[] {
  return [
    ...new Set(
      requirePermissionCalls(source).flatMap((call) =>
        [...call.matchAll(PERMISSION_LITERAL_PATTERN)].map((match) => match[1]),
      ),
    ),
  ];
}

function helperDefinitionsWithPermission(fileSource: string): Array<{
  name: string;
  source: string;
  permissions: string[];
}> {
  const functionPattern = /(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/gu;
  const definitions = [...fileSource.matchAll(functionPattern)];
  return definitions.flatMap((match, index) => {
    const source = fileSource.slice(
      match.index,
      definitions[index + 1]?.index ?? fileSource.length,
    );
    const permissionIndex = source.indexOf("requirePermission(");
    if (permissionIndex < 0) return [];
    return [
      {
        name: match[1],
        source,
        permissions: permissionLiterals(source.slice(permissionIndex)),
      },
    ];
  });
}

function findEffectiveGuard(routeMethod: RouteMethodSource): {
  index: number;
  permissions: string[];
  helperSource: string | null;
} | null {
  const directIndex = routeMethod.methodSource.indexOf("requirePermission(");
  if (directIndex >= 0) {
    return {
      index: directIndex,
      permissions: permissionLiterals(routeMethod.methodSource),
      helperSource: null,
    };
  }

  const mutationBoundaryIndex =
    routeMethod.methodSource.indexOf("beginTeamMutation(");
  if (mutationBoundaryIndex >= 0) {
    return {
      index: mutationBoundaryIndex,
      permissions: mutationBoundaryPermissions(routeMethod.methodSource),
      helperSource: null,
    };
  }

  for (const helper of helperDefinitionsWithPermission(
    routeMethod.fileSource,
  )) {
    const callPattern = new RegExp(
      `\\b${helper.name}\\s*\\(\\s*(?:_?request)\\b`,
      "u",
    );
    const match = callPattern.exec(routeMethod.methodSource);
    if (match) {
      return {
        index: match.index,
        permissions: helper.permissions,
        helperSource: helper.source,
      };
    }
  }
  return null;
}

function firstSensitiveBoundary(source: string): number | null {
  const boundaries = [
    /\bgetDb\s*\(/u,
    /\bfetch\s*\(/u,
    /\bcontext\.params\b/u,
    /\brequest\.(?:arrayBuffer|formData|json|text)\s*\(/u,
    /\brequest\.(?:nextUrl|url)\b/u,
    /\.(?:delete|insert|select|update)\s*\(/u,
  ];
  const indexes = boundaries
    .map((pattern) => pattern.exec(source)?.index ?? -1)
    .filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : null;
}

function assertGuardPrecedesSensitiveWork(
  routeMethod: RouteMethodSource,
  guard: NonNullable<ReturnType<typeof findEffectiveGuard>>,
): void {
  const workBeforeGuard = routeMethod.methodSource
    .slice(0, guard.index)
    .replace(/\bawait\s*$/u, "");
  expect(workBeforeGuard).not.toMatch(/\bawait\b/u);
  const firstMethodBoundary = firstSensitiveBoundary(routeMethod.methodSource);
  if (firstMethodBoundary !== null) {
    expect(guard.index).toBeLessThan(firstMethodBoundary);
  }

  if (guard.helperSource) {
    const helperGuardIndex = guard.helperSource.indexOf("requirePermission(");
    const firstHelperBoundary = firstSensitiveBoundary(guard.helperSource);
    expect(helperGuardIndex).toBeGreaterThanOrEqual(0);
    const helperWorkBeforeGuard = guard.helperSource
      .slice(0, helperGuardIndex)
      .replace(/\bawait\s*$/u, "");
    expect(helperWorkBeforeGuard).not.toMatch(/\bawait\b/u);
    if (firstHelperBoundary !== null) {
      expect(helperGuardIndex).toBeLessThan(firstHelperBoundary);
    }
  }
}

function exemptionFor(route: string, method: TeamRouteHttpMethod) {
  return TEAM_ROUTE_SECURITY_EXEMPTIONS.find(
    (exemption) => exemption.route === route && exemption.method === method,
  );
}

const scopedRouteFiles = TEAM_ROUTE_SECURITY_ROOTS.flatMap(listRouteFiles);
const scopedRouteMethods = [...new Set(scopedRouteFiles)]
  .sort()
  .flatMap(readRouteMethods);

describe("/team API route security manifest", () => {
  it("recursively inventories every exported HTTP route method in scope", () => {
    expect(scopedRouteFiles.length).toBeGreaterThan(100);
    expect(scopedRouteMethods.length).toBeGreaterThan(scopedRouteFiles.length);
    expect(scopedRouteMethods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: "app/api/admin/contacts/route.ts",
          method: "GET",
        }),
        expect.objectContaining({
          route: "app/api/admin/contacts/route.ts",
          method: "POST",
        }),
        expect.objectContaining({
          route:
            "app/api/admin/inbox/messages/[messageId]/media/[index]/route.ts",
          method: "HEAD",
        }),
        expect.objectContaining({
          route: "app/api/appointment-media/[id]/upload/route.ts",
          method: "PUT",
        }),
      ]),
    );
  });

  it.each(scopedRouteMethods)(
    "$method $route declares an effective permission guard before parsing or I/O",
    (routeMethod) => {
      const exemption = exemptionFor(routeMethod.route, routeMethod.method);
      if (exemption) {
        for (const evidence of exemption.requiredEvidence) {
          expect(routeMethod.methodSource).toContain(evidence);
        }
        return;
      }

      const guard = findEffectiveGuard(routeMethod);
      expect(guard).not.toBeNull();
      if (!guard) return;
      expect(guard.permissions.length).toBeGreaterThan(0);
      assertGuardPrecedesSensitiveWork(routeMethod, guard);
    },
  );

  it("assigns permission, risk, idempotency, and audit contracts to every guarded method", () => {
    const contracts = scopedRouteMethods.flatMap((routeMethod) => {
      if (exemptionFor(routeMethod.route, routeMethod.method)) return [];
      const guard = findEffectiveGuard(routeMethod);
      if (!guard) return [];
      return [
        buildTeamRouteSecurityContract({
          route: routeMethod.route,
          method: routeMethod.method,
          permissions: guard.permissions,
        }),
      ];
    });

    expect(contracts.length).toBe(
      scopedRouteMethods.length - TEAM_ROUTE_SECURITY_EXEMPTIONS.length,
    );
    for (const contract of contracts) {
      expect(contract.permissions.length).toBeGreaterThan(0);
      expect(contract.requiredPermissions).toEqual(contract.permissions);
      expect(contract.principalTypes.length).toBeGreaterThan(0);
      expect([
        "read",
        "normal",
        "external",
        "financial",
        "destructive",
      ]).toContain(contract.risk);
      expect(typeof contract.requiresIdempotency).toBe("boolean");
      expect(typeof contract.auditRequired).toBe("boolean");
      if (contract.auditRequired) {
        expect(contract.auditActionExpectation).toMatch(/^team_api\./u);
      } else {
        expect(contract.auditActionExpectation).toBeNull();
      }
      expect(contract.auditAction).toMatch(/^team_api\./u);
    }
  });

  it("keeps the service-only outbox dispatcher behind both permission and principal checks", () => {
    const routeMethod = scopedRouteMethods.find(
      ({ route, method }) =>
        route === "app/api/admin/outbox/dispatch/route.ts" && method === "POST",
    );
    expect(routeMethod).toBeDefined();
    expect(routeMethod?.methodSource).toContain(
      'requirePermission(request, "outbox.dispatch")',
    );
    expect(routeMethod?.methodSource).toContain(
      'permissionContext.source !== "service"',
    );
  });

  it("keeps break-glass exchange POST-only and service-only", () => {
    const routeMethods = scopedRouteMethods.filter(
      ({ route }) =>
        route === "app/api/admin/team/break-glass/exchange/route.ts",
    );
    expect(routeMethods).toHaveLength(1);
    expect(routeMethods[0]?.method).toBe("POST");
    expect(routeMethods[0]?.methodSource).toContain(
      'requiredPermissions: ["access.break_glass"]',
    );
    expect(routeMethods[0]?.methodSource).toContain(
      'principalTypes: ["service"]',
    );
    const contract = buildTeamRouteSecurityContract({
      route: routeMethods[0]!.route,
      method: routeMethods[0]!.method,
      permissions: ["access.break_glass"],
    });
    expect(contract.serviceOnly).toBe(true);
    expect(contract.principalTypes).toEqual(["service"]);
  });

  it("keeps all exemptions narrow, evidenced, and inside the protected scope", () => {
    const uniqueKeys = new Set<string>();
    for (const exemption of TEAM_ROUTE_SECURITY_EXEMPTIONS) {
      const key = `${exemption.method} ${exemption.route}`;
      expect(uniqueKeys.has(key)).toBe(false);
      uniqueKeys.add(key);
      expect(routeIsInTeamSecurityScope(exemption.route)).toBe(true);
      expect(exemption.kind).toBe("signed_callback");
      expect(exemption.reason.length).toBeGreaterThan(40);
      expect(exemption.requiredEvidence.length).toBeGreaterThanOrEqual(3);
      expect(exemption.auditActionExpectation).toMatch(/^team_api\./u);
    }
  });

  it("reports and locks protected shared routes still outside the migrated set", () => {
    const allApiRoutes = listRouteFiles("app/api");
    const discoveredBacklog = allApiRoutes
      .filter((route) => !routeIsInTeamSecurityScope(route))
      .flatMap((route) => {
        const source = fs.readFileSync(path.resolve(API_ROOT, route), "utf8");
        if (
          !source.includes("requirePermission(") &&
          !source.includes("beginTeamMutation(") &&
          !source.includes("isAdminRequest(")
        ) {
          return [];
        }
        return readRouteMethods(route).map(({ method }) => ({ route, method }));
      })
      .sort((left, right) =>
        `${left.route}#${left.method}`.localeCompare(
          `${right.route}#${right.method}`,
        ),
      );

    const declaredBacklog = TEAM_ROUTE_SECURITY_MIGRATION_BACKLOG as readonly {
      route: string;
      methods: readonly TeamRouteHttpMethod[];
      reason: string;
    }[];
    const expectedBacklog = declaredBacklog
      .flatMap(({ route, methods }) =>
        methods.map((method) => ({ route, method })),
      )
      .sort((left, right) =>
        `${left.route}#${left.method}`.localeCompare(
          `${right.route}#${right.method}`,
        ),
      );

    expect(discoveredBacklog).toEqual(expectedBacklog);
    for (const item of declaredBacklog) {
      expect(item.reason.length).toBeGreaterThan(40);
    }
  });
});
