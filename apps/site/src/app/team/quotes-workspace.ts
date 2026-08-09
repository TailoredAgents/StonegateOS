import type { Route } from "next";
import {
  teamSurfaceHref,
  type TeamSurfaceHrefOptions,
} from "./surface-registry";

export const QUOTE_WORKSPACE_MODES = ["create", "manage", "instant"] as const;

export type QuoteWorkspaceMode = (typeof QUOTE_WORKSPACE_MODES)[number];

export type QuoteWorkspaceRoute = {
  mode: QuoteWorkspaceMode;
  canonical: boolean;
};

export function normalizeQuoteWorkspaceMode(
  value: string | null | undefined,
): QuoteWorkspaceMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "create" ||
    normalized === "builder" ||
    normalized === "canvass"
  ) {
    return "create";
  }
  if (normalized === "instant") return "instant";
  return "manage";
}

export function resolveQuoteWorkspaceRoute(
  workspace: readonly string[],
): QuoteWorkspaceRoute | null {
  if (workspace.length === 1 && workspace[0] === "quotes") {
    return { mode: "manage", canonical: false };
  }
  if (workspace.length !== 2 || workspace[0] !== "quotes") return null;
  const mode = workspace[1];
  if (!QUOTE_WORKSPACE_MODES.includes(mode as QuoteWorkspaceMode)) return null;
  return { mode: mode as QuoteWorkspaceMode, canonical: true };
}

export function quoteWorkspaceHref(
  mode: QuoteWorkspaceMode,
  options: TeamSurfaceHrefOptions = {},
): Route {
  const canonicalManageHref = String(teamSurfaceHref("quotes", options));
  return canonicalManageHref.replace(
    "/team/quotes/manage",
    `/team/quotes/${mode}`,
  ) as Route;
}
