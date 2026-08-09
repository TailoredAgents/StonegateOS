const SAFE_REQUEST_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type TeamOriginRequest = Pick<Request, "headers" | "method" | "url">;

export function teamRequestRequiresOrigin(method: string): boolean {
  return !SAFE_REQUEST_METHODS.has(method.trim().toUpperCase());
}

/**
 * Team mutations are authorized by a cookie-backed session, so every unsafe
 * browser request must also prove that it originated at this exact Site
 * origin. SameSite cookies remain useful defense in depth, but are not the
 * authorization boundary and are not consistently enforced by every client.
 */
export function isSameOriginTeamRequest(request: TeamOriginRequest): boolean {
  if (!teamRequestRequiresOrigin(request.method)) return true;

  const rawOrigin = request.headers.get("origin")?.trim() ?? "";
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!rawOrigin || rawOrigin === "null") return false;
  if (fetchSite && fetchSite !== "same-origin") return false;

  try {
    const origin = new URL(rawOrigin);
    const target = new URL(request.url);
    return (
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash &&
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.origin.toLowerCase() === target.origin.toLowerCase()
    );
  } catch {
    return false;
  }
}
