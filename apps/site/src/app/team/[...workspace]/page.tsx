import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import TeamPage from "../page";
import {
  normalizeQuoteWorkspaceMode,
  quoteWorkspaceHref,
  resolveQuoteWorkspaceRoute,
} from "../quotes-workspace";
import { TEAM_SURFACES, type TeamSurfaceQueryValue } from "../surface-registry";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type TeamPageProps = Parameters<typeof TeamPage>[0];

function findSurface(workspace: readonly string[]) {
  const canonicalPath = `/team/${workspace.map(encodeURIComponent).join("/")}`;
  const exact = TEAM_SURFACES.find(
    (candidate) => candidate.canonicalPath === canonicalPath,
  );
  if (exact) return exact;
  if (canonicalPath === "/team/sales/outbound/partners") {
    return TEAM_SURFACES.find((candidate) => candidate.id === "partners");
  }
  return resolveQuoteWorkspaceRoute(workspace)
    ? TEAM_SURFACES.find((candidate) => candidate.id === "quotes")
    : undefined;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string[] }>;
}): Promise<Metadata> {
  const { workspace } = await params;
  const surface = findSurface(workspace);
  return {
    title: surface ? `${surface.label} | Stonegate Team` : "Stonegate Team",
    robots: { index: false, follow: false },
  };
}

export default async function CanonicalTeamWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string[] }>;
  searchParams: TeamPageProps["searchParams"];
}) {
  const { workspace } = await params;
  const surface = findSurface(workspace);
  if (!surface) notFound();

  const currentSearchParams = await searchParams;
  const requestedQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(currentSearchParams ?? {})) {
    if (key === "_canonical") continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === "string") requestedQuery.append(key, entry);
    }
  }
  const requestedPath = `/team/${workspace.map(encodeURIComponent).join("/")}${requestedQuery.size ? `?${requestedQuery.toString()}` : ""}`;
  if (
    surface.id === "partners" &&
    `/team/${workspace.map(encodeURIComponent).join("/")}` !==
      surface.canonicalPath
  ) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(currentSearchParams ?? {})) {
      if (typeof value === "string" && value.length > 0) query.set(key, value);
    }
    // Old Outbound partner bookmarks refer to the relationship history, not
    // a similarly named canonical company. Keep explicit newer views intact.
    if (!query.has("p_admin")) query.set("p_admin", "relationships");
    redirect(
      `${surface.canonicalPath}${query.size ? `?${query.toString()}` : ""}`,
    );
  }
  const quoteRoute = resolveQuoteWorkspaceRoute(workspace);
  if (surface.id === "quotes" && quoteRoute) {
    const legacyMode =
      typeof currentSearchParams?.quoteMode === "string"
        ? currentSearchParams.quoteMode
        : undefined;
    const mode =
      quoteRoute.canonical && quoteRoute.mode !== "manage"
        ? quoteRoute.mode
        : legacyMode
          ? normalizeQuoteWorkspaceMode(legacyMode)
          : quoteRoute.mode;
    const mustCanonicalize =
      !quoteRoute.canonical || Boolean(legacyMode) || mode !== quoteRoute.mode;
    if (mustCanonicalize) {
      const preservedQuery = Object.fromEntries(
        Object.entries(currentSearchParams ?? {}).filter(
          ([key]) =>
            key !== "quoteMode" && key !== "tab" && key !== "_canonical",
        ),
      ) as Record<string, TeamSurfaceQueryValue>;
      redirect(quoteWorkspaceHref(mode, { query: preservedQuery }));
    }
    return TeamPage({
      requestedPath,
      searchParams: Promise.resolve({
        ...currentSearchParams,
        quoteMode: mode,
        tab: surface.id,
        _canonical: "1",
      }),
    });
  }

  return TeamPage({
    requestedPath,
    searchParams: Promise.resolve({
      ...currentSearchParams,
      tab: surface.id,
      _canonical: "1",
    }),
  });
}
