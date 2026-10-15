import assert from "node:assert/strict";
import test from "node:test";
import {
  getTeamNavigationSurfaces,
  TEAM_NAVIGATION_SURFACES,
  TEAM_SURFACE_GROUP_ORDER,
} from "../src/app/team/surface-registry";

void test("Partner workspaces are together without restoring retired Sales navigation", () => {
  const navigationIds: readonly string[] = TEAM_NAVIGATION_SURFACES.map(
    (surface) => surface.id,
  );

  assert.equal(navigationIds.includes("outbound"), true);
  assert.equal(navigationIds.includes("partners"), true);
  assert.equal(
    TEAM_NAVIGATION_SURFACES.find((surface) => surface.id === "partners")
      ?.group,
    "sales",
  );
  assert.equal(
    navigationIds.indexOf("partners"),
    navigationIds.indexOf("outbound") + 1,
  );
  assert.equal(TEAM_SURFACE_GROUP_ORDER.includes("sales"), true);
  assert.equal(navigationIds.includes("pipeline"), false);
  assert.equal(navigationIds.includes("sales-hq"), false);
  assert.equal(navigationIds.includes("sales-log"), false);
});

void test("Outbound navigation remains permission gated", () => {
  const allowedIds = getTeamNavigationSurfaces(["outbound.read"]).map(
    (surface) => surface.id,
  );
  const deniedIds = getTeamNavigationSurfaces([]).map((surface) => surface.id);

  assert.equal(allowedIds.includes("outbound"), true);
  assert.equal(deniedIds.includes("outbound"), false);
});

void test("Partners navigation keeps its independent permission gate", () => {
  const allowedIds = getTeamNavigationSurfaces(["partners.accounts.read"]).map(
    (surface) => surface.id,
  );
  const outboundOnlyIds = getTeamNavigationSurfaces(["outbound.read"]).map(
    (surface) => surface.id,
  );

  assert.equal(allowedIds.includes("partners"), true);
  assert.equal(allowedIds.includes("outbound"), false);
  assert.equal(outboundOnlyIds.includes("partners"), false);
});
