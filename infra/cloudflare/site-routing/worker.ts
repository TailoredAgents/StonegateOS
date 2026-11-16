import { createHash, timingSafeEqual } from "node:crypto";
import { preservedStatic } from "./static";
interface Env {
  ASSETS: R2Bucket;
  MIGRATION_PROBE_TOKEN: string;
  SOURCE_SITE?: Fetcher;
  PUBLIC_STATIC?: string;
}
// Public routes serve only immutable static files from both site builds. The
// private read-only rehearsal also checks origin HTML and the candidate binding.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const supplied = request.headers.get("x-migration-gateway-key") ?? "";
    const incomingUrl = new URL(request.url);
    const publicStatic =
      env.PUBLIC_STATIC === "true" &&
      incomingUrl.protocol === "https:" &&
      ["stonegatejunkremoval.com", "www.stonegatejunkremoval.com"].includes(
        incomingUrl.hostname,
      ) &&
      incomingUrl.pathname.startsWith("/_next/static/");
    if (
      !publicStatic &&
      (!env.MIGRATION_PROBE_TOKEN ||
        supplied.length > 512 ||
        !timingSafeEqual(
          createHash("sha256").update(supplied).digest(),
          createHash("sha256").update(env.MIGRATION_PROBE_TOKEN).digest(),
        ))
    )
      return new Response(null, { status: 401 });
    if (!publicStatic && Date.now() >= Date.parse("2026-11-22T22:00:00Z"))
      return new Response(null, { status: 410 });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/candidate/")) {
      const targetPath = url.pathname.slice("/candidate".length);
      if (
        !env.SOURCE_SITE ||
        url.search ||
        !(
          targetPath.startsWith("/_next/static/") ||
          [
            "/",
            "/book",
            "/partners/login",
            "/team/login",
            "/mobile/login",
            "/api/healthz",
            "/api/team/directory",
            "/__gateway/status",
          ].includes(targetPath)
        )
      )
        return new Response(null, { status: 404 });
      const response = await env.SOURCE_SITE.fetch(
        new Request(
          "https://" +
            (request.headers.get("x-migration-preview-host") ===
            "www.stonegatejunkremoval.com"
              ? "www.stonegatejunkremoval.com"
              : "stonegatejunkremoval.com") +
            targetPath,
          {
            method: request.method,
            headers: { accept: request.headers.get("accept") ?? "*/*" },
            redirect: "manual",
            signal: AbortSignal.timeout(30000),
          },
        ),
      );
      const result = new Response(response.body, response);
      result.headers.set(
        "x-migration-site-route",
        "cloudflare-candidate-binding",
      );
      return result;
    }
    const asset = await preservedStatic(request, env.ASSETS);
    if (asset) {
      asset.headers.set("x-migration-site-route", "preserved-static");
      return asset;
    }
    if (publicStatic) {
      const headers = new Headers(request.headers);
      for (const name of [...headers.keys()])
        if (name.toLowerCase().startsWith("x-migration-")) headers.delete(name);
      return fetch(new Request(request, { headers }));
    }
    if (
      ![
        "/",
        "/book",
        "/partners/login",
        "/team/login",
        "/mobile/login",
        "/api/healthz",
      ].includes(url.pathname) ||
      url.search
    )
      return new Response(null, { status: 404 });
    const host =
      request.headers.get("x-migration-preview-host") ??
      "stonegatejunkremoval.com";
    if (
      !["stonegatejunkremoval.com", "www.stonegatejunkremoval.com"].includes(
        host,
      )
    )
      return new Response(null, { status: 400 });
    url.hostname = host;
    url.port = "";
    url.protocol = "https:";
    const response = await fetch(url, {
      method: request.method,
      headers: { accept: request.headers.get("accept") ?? "*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    const result = new Response(response.body, response);
    result.headers.set("x-migration-site-route", "render-origin");
    result.headers.set("cache-control", "no-store");
    result.headers.set("x-robots-tag", "noindex, nofollow");
    return result;
  },
} satisfies ExportedHandler<Env>;
