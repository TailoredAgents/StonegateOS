import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPOSITORY_ROOT = join(process.cwd(), "../..");
const SITE_SOURCE = join(REPOSITORY_ROOT, "apps/site/src");
const SITE_TEAM_SOURCE = join(SITE_SOURCE, "app/team");
const SITE_TEAM_ROUTE_SOURCE = join(SITE_SOURCE, "app/api/team");
const COMPATIBILITY_HELPER = "app/team/lib/api.ts";
const REPOSITORY_SOURCE_ROOTS = ["apps", "packages", "tests"];
const IGNORED_DIRECTORIES = new Set([
  ".contentlayer",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

type SourceFile = {
  path: string;
  source: string;
};

function readTypeScriptSources(
  root: string,
  relativeTo = SITE_SOURCE,
): SourceFile[] {
  const sources: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(absolutePath);
      } else if (/\.tsx?$/u.test(entry.name)) {
        sources.push({
          path: relative(relativeTo, absolutePath),
          source: readFileSync(absolutePath, "utf8"),
        });
      }
    }
  };
  visit(root);
  return sources;
}

describe("admin API helper naming and principal contract", () => {
  const allSiteSources = readTypeScriptSources(SITE_SOURCE);
  const allRepositorySources = REPOSITORY_SOURCE_ROOTS.flatMap((root) =>
    readTypeScriptSources(join(REPOSITORY_ROOT, root), REPOSITORY_ROOT),
  );
  const teamSources = [
    ...readTypeScriptSources(SITE_TEAM_SOURCE),
    ...readTypeScriptSources(SITE_TEAM_ROUTE_SOURCE),
  ];

  it("does not export or invoke the ambiguous implicit-principal helper", () => {
    const violations = allRepositorySources
      .filter(
        ({ source }) =>
          /\bcallAdminApi\s*\(/u.test(source) ||
          /export\s+(?:async\s+function|const)\s+callAdminApi\b/u.test(source),
      )
      .map(({ path }) => path);

    expect(violations).toEqual([]);
  });

  it("keeps the current-session compatibility bridge out of /team callers", () => {
    const violations = teamSources
      .filter(
        ({ path, source }) =>
          path !== COMPATIBILITY_HELPER &&
          /\bcallAdminApiForCurrentSession\b/u.test(source),
      )
      .map(({ path }) => path);

    expect(violations).toEqual([]);
  });

  it("labels the compatibility bridge and delegates through a verified principal", () => {
    const helper = allSiteSources.find(
      ({ path }) => path === COMPATIBILITY_HELPER,
    )?.source;

    expect(helper).toBeDefined();
    expect(helper).toContain(
      "export async function callAdminApiForCurrentSession(",
    );
    expect(helper).toContain("await requireCurrentTeamPrincipal()");
    expect(helper).toContain("return callAdminApiAs(principal, path, init)");
  });
});
