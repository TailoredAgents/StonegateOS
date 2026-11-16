import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { syntheticCheck } from "./check";
import { syntheticSiteCheck } from "./site-check";
import { upstreamRequest, trackedResponse } from "../http-gateway/proxy.mjs";

interface Env {
  MIGRATION_SYNTHETIC_CONNECTION: string;
  MIGRATION_PROBE_TOKEN: string;
  API: DurableObjectNamespace<SyntheticApi>;
  OUTBOX: DurableObjectNamespace<SyntheticOutbox>;
  SITE: DurableObjectNamespace<SyntheticSite>;
}

const relayPaths = new Set([
  "/api/public/team/session",
  "/api/admin/team/directory",
  "/api/admin/contacts",
]);

class SyntheticContainer extends DurableObject<Env> {
  private busy = false;
  async fetch(request: Request): Promise<Response> {
    const relayUrl = new URL(request.url);
    if (relayUrl.pathname.startsWith("/site/gateway/")) {
      if (!this.ctx.container!.running)
        return Response.json({ error: "site_unavailable" }, { status: 503 });
      relayUrl.pathname = relayUrl.pathname.slice("/site/gateway".length);
      const forwarded = upstreamRequest(new Request(relayUrl, request));
      const response = await this.ctx
        .container!.getTcpPort(8081)
        .fetch(forwarded);
      return trackedResponse(response, () => {});
    }
    if (relayUrl.pathname.startsWith("/relay/")) {
      const pathname = relayUrl.pathname.slice(6);
      if (
        !(
          request.method === "GET" ||
          (request.method === "POST" && pathname === "/api/admin/contacts")
        ) ||
        !relayPaths.has(pathname) ||
        !this.ctx.container!.running
      )
        return Response.json({ error: "relay_unavailable" }, { status: 503 });
      const headers = new Headers(request.headers);
      headers.delete("x-migration-proxy-key");
      headers.delete("host");
      return this.ctx
        .container!.getTcpPort(8082)
        .fetch("http://container" + pathname + relayUrl.search, {
          method: request.method,
          headers,
          body: request.body,
          signal: AbortSignal.timeout(10000),
        });
    }
    if (this.busy)
      return Response.json({ error: "probe_running" }, { status: 409 });
    this.busy = true;
    try {
      const container = this.ctx.container!;
      const url = new URL(request.url);
      if (url.pathname.endsWith("/stop")) {
        await container.destroy();
        return Response.json({ stopped: true });
      }
      if (!this.env.MIGRATION_SYNTHETIC_CONNECTION)
        throw Error("Missing synthetic credentials");
      if (!container.running) {
        container.start({
          image: container.images.base,
          instance: {
            vcpu: 1,
            memoryMib: url.pathname.startsWith("/outbox/") ? 1024 : 2048,
            diskMb: 4000,
          },
          enableInternet: true,
        });
        this.ctx.waitUntil(
          container
            .monitor()
            .catch(() =>
              console.error(
                JSON.stringify({ event: "synthetic_container_stopped" }),
              ),
            ),
        );
      }
      await container.setInactivityTimeout(180000);
      let ready = false;
      for (let i = 0; i < 120; i++) {
        try {
          const r = await container
            .getTcpPort(8080)
            .fetch("http://container/api/healthz", {
              signal: AbortSignal.timeout(1000),
            });
          await r.body?.cancel();
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await scheduler.wait(250);
      }
      if (!ready) throw Error("Synthetic container not ready");
      const isSite = url.pathname === "/site/check";
      const fixture = isSite ? await request.text() : "";
      if (fixture.length > 4096)
        return Response.json({ error: "fixture_too_large" }, { status: 413 });
      const code = isSite ? syntheticSiteCheck : syntheticCheck;
      const process = await container.exec(["node", "-e", code], {
        cwd: "/app",
        stdout: "pipe",
        stderr: "ignore",
        env: {
          ...(isSite
            ? { MIGRATION_SITE_FIXTURE: fixture }
            : {
                MIGRATION_SYNTHETIC_CONNECTION:
                  this.env.MIGRATION_SYNTHETIC_CONNECTION,
              }),
          MIGRATION_PROBE_TOKEN: this.env.MIGRATION_PROBE_TOKEN,
          MIGRATION_SITE_PROBE_HASH: createHash("sha256")
            .update(syntheticSiteCheck)
            .digest("hex"),
          NODE_EXTRA_CA_CERTS:
            "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
          MIGRATION_MODE: url.pathname.endsWith("/delivery-check")
            ? "delivery"
            : url.pathname.startsWith("/outbox/")
              ? "outbox"
              : url.pathname.endsWith("/webhook-check")
                ? "webhooks"
                : url.pathname.endsWith("/booking-check")
                  ? "booking"
                  : url.pathname.endsWith("/site-check")
                    ? "site"
                    : "api",
        },
        signal: AbortSignal.timeout(
          url.pathname === "/api/site-check" ? 180000 : 110000,
        ),
      });
      const result = await process.output();
      if (!result.stdout.byteLength)
        return Response.json(
          { ok: false, code: "PROBE_STARTUP_FAILED" },
          { status: 503 },
        );
      return new Response(result.stdout, {
        status: result.exitCode === 0 ? 200 : 503,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-stonegate-probe-sha256": createHash("sha256")
            .update(code)
            .digest("hex"),
        },
      });
    } finally {
      this.busy = false;
    }
  }
}
export class SyntheticApi extends SyntheticContainer {}
export class SyntheticOutbox extends SyntheticContainer {}
export class SyntheticSite extends SyntheticContainer {}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = new URL(request.url).pathname;
    const authorization =
      route.startsWith("/relay/") || route.startsWith("/site/gateway/")
        ? `Bearer ${request.headers.get("x-migration-proxy-key") ?? ""}`
        : (request.headers.get("authorization") ?? "");
    if (
      !env.MIGRATION_PROBE_TOKEN ||
      authorization.length > 512 ||
      !timingSafeEqual(
        createHash("sha256").update(authorization).digest(),
        createHash("sha256")
          .update(`Bearer ${env.MIGRATION_PROBE_TOKEN}`)
          .digest(),
      )
    )
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (
      !(
        (request.method === "GET" ||
          (request.method === "POST" &&
            route === "/relay/api/admin/contacts")) &&
        route.startsWith("/relay/") &&
        relayPaths.has(route.slice(6))
      ) &&
      !(
        (request.method === "GET" || request.method === "POST") &&
        [
          "/site/gateway/api/team/directory",
          "/site/gateway/api/team/contacts",
        ].includes(route)
      ) &&
      (request.method !== "POST" ||
        !(
          /^\/(api|outbox|site)\/(check|stop)$/.test(route) ||
          route === "/api/booking-check" ||
          route === "/api/webhook-check" ||
          route === "/api/site-check" ||
          route === "/outbox/delivery-check"
        ))
    )
      return Response.json({ error: "not_found" }, { status: 404 });
    const namespace = route.startsWith("/site/")
      ? env.SITE
      : route.startsWith("/outbox/")
        ? env.OUTBOX
        : env.API;
    try {
      return await namespace
        .getByName("synthetic-v1", { locationHint: "enam" })
        .fetch(request);
    } catch {
      console.error(JSON.stringify({ event: "synthetic_probe_failed" }));
      return Response.json({ error: "probe_failed" }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
