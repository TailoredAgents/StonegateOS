import type { Route } from "next";
import { safeTeamReturnPath } from "@myst-os/sdk";
import {
  teamSurfaceHref,
  type TeamSurfaceHrefOptions,
  type TeamSurfaceQueryValue,
} from "./surface-registry";

export const QUOTE_WORKSPACE_MODES = ["create", "manage", "instant"] as const;

export type QuoteWorkspaceMode = (typeof QUOTE_WORKSPACE_MODES)[number];

export type QuoteWorkspaceRoute = {
  mode: QuoteWorkspaceMode;
  canonical: boolean;
};

export type QuoteWorkspaceHrefOptions = TeamSurfaceHrefOptions & {
  returnTo?: unknown;
};

const QUOTE_RETURN_QUERY_KEY = "quote_return";

function copyQuery(query: QuoteWorkspaceHrefOptions["query"]): URLSearchParams {
  const copied = new URLSearchParams();
  const entries: ReadonlyArray<readonly [string, TeamSurfaceQueryValue]> =
    query instanceof URLSearchParams
      ? Array.from(query.entries())
      : Object.entries(query ?? {});
  for (const [key, rawValue] of entries) {
    if (key === QUOTE_RETURN_QUERY_KEY) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== null && value !== undefined) {
        copied.append(key, String(value));
      }
    }
  }
  return copied;
}

/** Accept an internal Team origin while preventing a Quote-to-Quote loop. */
export function safeQuoteWorkspaceReturnPath(value: unknown): string | null {
  const returnTo = safeTeamReturnPath(value);
  if (!returnTo) return null;
  const target = new URL(returnTo, "https://team-return.invalid");
  if (
    target.pathname === "/team/quotes" ||
    target.pathname.startsWith("/team/quotes/") ||
    (target.pathname === "/team" &&
      ["quotes", "quote-builder", "canvass"].includes(
        target.searchParams.get("tab") ?? "",
      ))
  ) {
    return null;
  }
  return returnTo;
}

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
  options: QuoteWorkspaceHrefOptions = {},
): Route {
  const query = copyQuery(options.query);
  const returnTo = safeQuoteWorkspaceReturnPath(options.returnTo);
  if (returnTo) query.set(QUOTE_RETURN_QUERY_KEY, returnTo);
  const canonicalManageHref = String(
    teamSurfaceHref("quotes", { query, hash: options.hash }),
  );
  return canonicalManageHref.replace(
    "/team/quotes/manage",
    `/team/quotes/${mode}`,
  ) as Route;
}
