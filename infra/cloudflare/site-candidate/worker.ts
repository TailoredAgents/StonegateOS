import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { staticInventory } from "./static-inventory";

interface CandidateEnv {
  SITE: DurableObjectNamespace<SiteCandidate>;
  SITE_RUNTIME_ENV: string;
  MIGRATION_PROBE_TOKEN: string;
}
const idleMs = 180_000;
const expiresAt = Date.parse("2026-11-22T22:00:00Z");
const publicPages = new Set([
  "/",
  "/book",
  "/partners/login",
  "/team/login",
  "/mobile/login",
  "/api/healthz",
]);
function allowedRead(request: Request): boolean {
  const url = new URL(request.url);
  const staticPath = url.pathname.replace(/%5b/gi, "[").replace(/%5d/gi, "]");
  return (
    request.method === "GET" &&
    !url.search &&
    (publicPages.has(url.pathname) ||
      /^\/_next\/static\/[a-zA-Z0-9_./@()~\[\]-]+$/.test(staticPath))
  );
}

// A bounded candidate deployment using the actual website entrypoint. It has
// no public domain routes and accepts only fixed, unauthenticated page reads.
export class SiteCandidate extends DurableObject<CandidateEnv> {
  private starting: Promise<void> | undefined;
  private stopping = false;
  private executionId = crypto.randomUUID();
  constructor(ctx: DurableObjectState, env: CandidateEnv) {
    super(ctx, env);
    if (ctx.container?.running)
      ctx.blockConcurrencyWhile(() =>
        ctx.container!.setInactivityTimeout(idleMs),
      );
  }
  private runtimeEnv(): Record<string, string> {
    const values: unknown = JSON.parse(this.env.SITE_RUNTIME_ENV);
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.values(values).some((value) => typeof value !== "string")
    )
      throw Error("Invalid runtime configuration");
    const result = values as Record<string, string>;
    if (
      result.API_BASE_URL !== "https://stonegate-api.onrender.com" ||
      result.DATABASE_URL
    )
      throw Error("Unexpected candidate upstream");
    return {
      ...result,
      PORT: "8080",
      NODE_ENV: "production",
      DOTENV_CONFIG_PATH: "/dev/null",
      NEXT_TELEMETRY_DISABLED: "1",
    };
  }
  private async healthy(): Promise<boolean> {
    if (!this.ctx.container!.running) return false;
    try {
      const r = await this.ctx
        .container!.getTcpPort(8080)
        .fetch("http://container/api/healthz", {
          signal: AbortSignal.timeout(3000),
        });
      await r.body?.cancel();
      return r.ok;
    } catch {
      return false;
    }
  }
  private async ensureReady(): Promise<void> {
    if (this.stopping) throw Error("Candidate stopping");
    const lease = await this.ctx.storage.get<number>("lease");
    if (!lease || Date.now() >= Math.min(lease, expiresAt))
      throw Error("Candidate lease expired");
    const container = this.ctx.container!;
    if (!container.running) {
      container.start({
        image: container.images.base,
        enableInternet: true,
        instance: { vcpu: 1, memoryMib: 2048, diskMb: 4000 },
        entrypoint: [
          "node",
          "/app/apps/site/node_modules/next/dist/bin/next",
          "start",
          "/app/apps/site",
          "--hostname",
          "0.0.0.0",
          "--port",
          "8080",
        ],
        env: this.runtimeEnv(),
        labels: { candidate: "site-v1", started: String(Date.now()) },
      });
    }
    await container.setInactivityTimeout(idleMs);
    const deadline = Date.now() + 110_000;
    while (Date.now() < deadline) {
      if (await this.healthy()) return;
      await scheduler.wait(500);
    }
    throw Error("Candidate readiness timeout");
  }
  private async stop(): Promise<void> {
    this.stopping = true;
    try {
      await this.ctx.storage.delete("lease");
      await this.ctx.storage.deleteAlarm();
      await this.starting?.catch(() => undefined);
      await this.ctx.container!.destroy();
    } finally {
      this.stopping = false;
    }
  }
  async alarm(): Promise<void> {
    const lease = await this.ctx.storage.get<number>("lease");
    if (!lease || Date.now() >= Math.min(lease, expiresAt)) {
      await this.stop();
      return;
    }
    const lastHealth = {
      at: Date.now(),
      healthy: await this.healthy(),
      executionId: this.executionId,
    };
    await this.ctx.storage.put("lastHealth", lastHealth);
    await this.ctx.storage.setAlarm(
      Math.min(lease, expiresAt, Date.now() + 90_000),
    );
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__candidate/stop") {
      await this.stop();
      return Response.json({ stopped: true });
    }
    if (request.method === "GET" && url.pathname === "/__candidate/status") {
      return Response.json({
        running: this.ctx.container!.running,
        healthy: await this.healthy(),
        image: await this.ctx.container!.inspect(),
        lease: await this.ctx.storage.get("lease"),
        lastHealth: await this.ctx.storage.get("lastHealth"),
        executionId: this.executionId,
      });
    }
    if (request.method === "POST" && url.pathname === "/__candidate/start") {
      await this.ctx.storage.put(
        "lease",
        Math.min(expiresAt, Date.now() + 3_600_000),
      );
      await this.ctx.storage.setAlarm(Date.now() + 90_000);
    } else if (
      url.pathname !== "/__candidate/static-manifest" &&
      !allowedRead(request)
    )
      return new Response(null, { status: 404 });
    this.starting ??= this.ensureReady().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    if (url.pathname === "/__candidate/start")
      return Response.json({
        ready: true,
        image: await this.ctx.container!.inspect(),
      });
    if (url.pathname === "/__candidate/static-manifest") {
      const process = await this.ctx.container!.exec(
        ["node", "-e", staticInventory],
        {
          stdout: "pipe",
          stderr: "ignore",
          signal: AbortSignal.timeout(10000),
        },
      );
      const result = await process.output();
      if (result.exitCode !== 0 || result.stdout.byteLength > 256 * 1024)
        throw Error("Static inventory failed");
      return new Response(result.stdout, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }
    const headers = new Headers();
    headers.set("accept", request.headers.get("accept") ?? "*/*");
    headers.set("host", "stonegatejunkremoval.com");
    headers.set("x-forwarded-host", "stonegatejunkremoval.com");
    headers.set("x-forwarded-proto", "https");
    // No cookies, bearer token, arbitrary forwarded headers or body reach Next.
    const response = await this.ctx
      .container!.getTcpPort(8080)
      .fetch(new Request("http://container" + url.pathname, { headers }));
    const output = new Response(response.body, response);
    output.headers.set("x-robots-tag", "noindex, nofollow");
    output.headers.set("cache-control", "no-store");
    return output;
  }
}
export default {
  async fetch(request: Request, env: CandidateEnv): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
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
      return new Response(null, { status: 401 });
    const url = new URL(request.url);
    const control =
      !url.search &&
      ((request.method === "POST" &&
        ["/__candidate/start", "/__candidate/stop"].includes(url.pathname)) ||
        (request.method === "GET" &&
          ["/__candidate/status", "/__candidate/static-manifest"].includes(
            url.pathname,
          )));
    if (!control && !allowedRead(request))
      return new Response(null, { status: 404 });
    if (Date.now() >= expiresAt && url.pathname !== "/__candidate/stop")
      return new Response(null, { status: 410 });
    try {
      return await env.SITE.getByName("site-candidate-v1", {
        locationHint: "enam",
      }).fetch(request);
    } catch {
      return Response.json(
        { error: "candidate_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  },
} satisfies ExportedHandler<CandidateEnv>;
