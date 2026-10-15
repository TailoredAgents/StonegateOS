import assert from "node:assert/strict";
import test from "node:test";
import {
  getTeamNavigationSurfaces,
  TEAM_NAVIGATION_SURFACES,
  TEAM_SURFACE_GROUP_ORDER,
} from "../src/app/team/surface-registry";

void test("Outbound is discoverable without restoring retired Sales navigation", () => {
  const navigationIds: readonly string[] = TEAM_NAVIGATION_SURFACES.map(
    (surface) => surface.id,
  );

  assert.equal(navigationIds.includes("outbound"), true);
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
