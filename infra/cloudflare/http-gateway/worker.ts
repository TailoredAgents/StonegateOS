import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { upstreamRequest, trackedResponse } from "./proxy.mjs";
import { fixture } from "./fixture";

interface GatewayEnv {
  HTTP: DurableObjectNamespace<HttpGateway>;
  MIGRATION_PROBE_TOKEN: string;
  SERVICE_KIND: "fixture" | "site" | "source-site" | "target-api";
  SITE_RUNTIME_ENV?: string;
  MIGRATION_TARGET_CONNECTION?: string;
  GATEWAY_HOST: string;
  AUTO_RECOVER?: string;
  OPERATION_MODE?: "rehearsal" | "production";
}
type State = {
  phase: "standby" | "warming" | "ready" | "active" | "draining" | "failed";
  generation: string;
  lease: number;
  desiredActive?: boolean;
  restarts?: number[];
};
const expiresAt = Date.parse("2026-11-22T22:00:00Z");
const idleMs = 180_000;
function unavailable(code = "gateway_unavailable", status = 503) {
  return Response.json(
    { error: code },
    { status, headers: { "cache-control": "no-store", "retry-after": "5" } },
  );
}
function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("x-migration-gateway-key") ?? "";
  return (
    !!token &&
    supplied.length < 512 &&
    timingSafeEqual(
      createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(token).digest(),
    )
  );
}

// Rehearsals stay private and time bounded. Only the separately configured
// source-site may admit production hosts; operator controls always require the
// dedicated secret. API and consumer promotion need their own runbook gates.
export class HttpGateway extends DurableObject<GatewayEnv> {
  private state: State = { phase: "standby", generation: "", lease: 0 };
  private controlling = false;
  private readiness: {
    siteStatus?: number;
    apiStatus?: number;
    error?: string;
    siteMs?: number;
    apiMs?: number;
  } = {};
  private inFlight = new Set<Promise<void>>();
  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<State>("state")) ?? this.state;
      if (ctx.container?.running)
        await ctx.container.setInactivityTimeout(idleMs);
    });
  }
  private async save() {
    await this.ctx.storage.put("state", this.state);
  }
  private validLease() {
    return (
      Date.now() <
      (this.env.OPERATION_MODE === "production"
        ? this.state.lease
        : Math.min(this.state.lease, expiresAt))
    );
  }
  private async healthy() {
    this.readiness = {};
    const started = Date.now();
    if (!this.ctx.container!.running) return false;
    try {
      const r = await this.ctx
        .container!.getTcpPort(8080)
        .fetch(
          this.env.SERVICE_KIND === "target-api"
            ? "http://container/api/readyz"
            : "http://container/api/healthz",
          {
            signal: AbortSignal.timeout(
              this.env.SERVICE_KIND === "source-site" ? 10000 : 2000,
            ),
          },
        );
      if (this.env.SERVICE_KIND === "target-api") {
        // This isolated API has no providers or consumer. Its readiness gate
        // requires the actual database and migration journal before activation.
        const body = (await r.json()) as {
          checks?: {
            database?: { state?: string };
            migrations?: { state?: string };
          };
        };
        return (
          body.checks?.database?.state === "ok" &&
          body.checks?.migrations?.state === "ok"
        );
      }
      await r.body?.cancel();
      this.readiness.siteStatus = r.status;
      this.readiness.siteMs = Date.now() - started;
      if (r.ok && this.env.SERVICE_KIND === "source-site") {
        const api = await fetch(
          "https://stonegate-api.onrender.com/api/readyz",
          { signal: AbortSignal.timeout(5000) },
        );
        const ready = api.ok;
        this.readiness.apiStatus = api.status;
        this.readiness.apiMs = Date.now() - started - this.readiness.siteMs;
        await api.body?.cancel();
        return ready;
      }
      return r.ok;
    } catch (error) {
      this.readiness.error =
        error instanceof Error ? error.name : "UnknownError";
      return false;
    }
  }
  private runtime() {
    if (this.env.SERVICE_KIND === "fixture")
      return {
        entrypoint: ["node", "-e", fixture],
        env: {},
        enableInternet: false,
      };
    if (this.env.SERVICE_KIND === "target-api") {
      const config = JSON.parse(this.env.MIGRATION_TARGET_CONNECTION ?? "{}");
      if (
        config.purpose !== "target-readiness-read-only" ||
        config.database !== "stonegate_restore_20261116" ||
        config.sqlRole !== "stonegate_target_probe_ro" ||
        !config.host?.endsWith(".psdb.cloud") ||
        !config.user?.startsWith(config.sqlRole + ".") ||
        !(Date.parse(config.expiresAt) > Date.now())
      )
        throw Error("Invalid read-only target configuration");
      const url = new URL(
        `postgres://${config.host}:${config.port}/${config.database}`,
      );
      url.username = config.user;
      url.password = config.password;
      return {
        entrypoint: [
          "node",
          "/app/apps/api/node_modules/next/dist/bin/next",
          "start",
          "/app/apps/api",
          "--hostname",
          "0.0.0.0",
          "--port",
          "8080",
        ],
        env: {
          DATABASE_URL: url.href,
          DATABASE_SSL: "true",
          DATABASE_SSL_SERVERNAME: config.host,
          ADMIN_API_KEY: "isolated-target-gateway-synthetic-key-only",
          TEAM_AUTH_RATE_LIMIT_SECRET:
            "isolated-target-gateway-synthetic-rate-limit-key",
          SITE_URL: `https://${this.env.GATEWAY_HOST}`,
          CORS_ALLOW_ORIGINS: `https://${this.env.GATEWAY_HOST}`,
          TEAM_KILL_EXTERNAL_SENDS: "true",
          TEAM_KILL_OUTBOX_DISPATCH: "true",
          TEAM_KILL_FINANCIAL_MUTATIONS: "true",
          TEAM_KILL_ADVERTISING_CHANGES: "true",
          TEAM_KILL_PUBLISHING: "true",
          TEAM_KILL_DESTRUCTIVE_MUTATIONS: "true",
          NODE_ENV: "production",
          PORT: "8080",
          DOTENV_CONFIG_PATH: "/dev/null",
          NEXT_TELEMETRY_DISABLED: "1",
        },
        enableInternet: true,
      };
    }
    if (
      !["site", "source-site"].includes(this.env.SERVICE_KIND) ||
      !this.env.SITE_RUNTIME_ENV
    )
      throw Error("Invalid service configuration");
    const values: unknown = JSON.parse(this.env.SITE_RUNTIME_ENV);
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.values(values).some((value) => typeof value !== "string")
    )
      throw Error("Invalid runtime settings");
    const env = values as Record<string, string>;
    const expectedApi =
      this.env.SERVICE_KIND === "source-site"
        ? "https://stonegate-api.onrender.com"
        : "http://127.0.0.1:8083";
    if (env.API_BASE_URL !== expectedApi || env.DATABASE_URL)
      throw Error("Unexpected site upstream");
    if (
      this.env.SERVICE_KIND === "source-site" &&
      env.SITE_URL !== "https://stonegatejunkremoval.com"
    )
      throw Error("Unexpected production site origin");
    return {
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
      env: {
        ...env,
        PORT: "8080",
        NODE_ENV: "production",
        DOTENV_CONFIG_PATH: "/dev/null",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      enableInternet: true,
    };
  }
  private async warm() {
    if (this.ctx.container!.running || this.inFlight.size)
      return unavailable("already_running", 409);
    this.state = {
      phase: "warming",
      generation: crypto.randomUUID(),
      lease:
        this.env.OPERATION_MODE === "production"
          ? Date.parse("2099-01-01T00:00:00Z")
          : Math.min(expiresAt, Date.now() + 3_600_000),
      desiredActive: false,
      restarts: [],
    };
    await this.save();
    await this.ctx.storage.setAlarm(
      Math.min(this.state.lease, Date.now() + 60_000),
    );
    this.ctx.container!.start({
      image: this.ctx.container!.images.base,
      ...this.runtime(),
      instance: { vcpu: 1, memoryMib: 2048, diskMb: 4000 },
      labels: { generation: this.state.generation },
    });
    await this.ctx.container!.setInactivityTimeout(idleMs);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await this.healthy()) {
        this.state.phase = "ready";
        await this.save();
        return Response.json({
          ...this.state,
          image: await this.ctx.container!.inspect(),
        });
      }
      await scheduler.wait(500);
    }
    this.state.phase = "failed";
    await this.save();
    return unavailable("readiness_timeout");
  }
  private async drain() {
    this.state.desiredActive = false;
    this.state.phase = "draining";
    await this.save();
    const deadline = Date.now() + 60_000;
    while (this.inFlight.size && Date.now() < deadline)
      await scheduler.wait(100);
    if (this.inFlight.size) return unavailable("drain_incomplete", 409);
    if (this.ctx.container!.running) {
      this.ctx.container!.signal(15);
      const stopDeadline = Date.now() + 15_000;
      while (this.ctx.container!.running && Date.now() < stopDeadline)
        await scheduler.wait(100);
      if (this.ctx.container!.running)
        return unavailable("shutdown_incomplete", 409);
    }
    this.state = {
      phase: "standby",
      generation: this.state.generation,
      lease: 0,
    };
    await this.save();
    await this.ctx.storage.deleteAlarm();
    return Response.json({ ...this.state, running: false, drained: true });
  }
  async alarm() {
    if (this.controlling) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    this.controlling = true;
    try {
      if (!this.validLease()) {
        await this.drain();
      } else {
        let healthy = await this.healthy();
        if (this.env.AUTO_RECOVER === "true" && this.state.desiredActive) {
          if (
            !healthy &&
            !this.ctx.container!.running &&
            this.inFlight.size === 0
          ) {
            const restarts = (this.state.restarts ?? []).filter(
              (at) => at > Date.now() - 3_600_000,
            );
            if (restarts.length < 3) {
              this.state = {
                ...this.state,
                phase: "warming",
                generation: crypto.randomUUID(),
                restarts: [...restarts, Date.now()],
              };
              await this.save();
              this.ctx.container!.start({
                image: this.ctx.container!.images.base,
                ...this.runtime(),
                instance: { vcpu: 1, memoryMib: 2048, diskMb: 4000 },
                labels: { generation: this.state.generation },
              });
              await this.ctx.container!.setInactivityTimeout(idleMs);
              const deadline = Date.now() + 120_000;
              while (Date.now() < deadline && this.validLease()) {
                healthy = await this.healthy();
                if (healthy) break;
                await scheduler.wait(500);
              }
            }
          }
          // Recovery changes admission for future requests only. No saved
          // business request or ambiguous mutation is replayed by this path.
          this.state.phase = healthy ? "active" : "failed";
          await this.save();
        }
        if (!healthy && this.state.phase === "active") {
          this.state.phase = "failed";
          await this.save();
        }
        await this.ctx.storage.put("lastHealth", { at: Date.now(), healthy });
      }
      if (this.state.phase !== "standby")
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
    } finally {
      this.controlling = false;
    }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__gateway/")) {
      if (url.pathname === "/__gateway/status")
        return Response.json({
          ...this.state,
          running: this.ctx.container!.running,
          inFlight: this.inFlight.size,
          image: await this.ctx.container!.inspect(),
          lastHealth: await this.ctx.storage.get("lastHealth"),
          readiness: this.readiness,
        });
      if (this.controlling) return unavailable("control_in_progress", 409);
      this.controlling = true;
      try {
        if (url.pathname === "/__gateway/warm") return await this.warm();
        if (url.pathname === "/__gateway/drain") return await this.drain();
        if (url.pathname === "/__gateway/activate") {
          if (
            this.state.phase !== "ready" ||
            !this.validLease() ||
            request.headers.get("x-stonegate-gateway-generation") !==
              this.state.generation ||
            !(await this.healthy())
          )
            return Response.json(
              { error: "candidate_not_ready", readiness: this.readiness },
              { status: 409, headers: { "cache-control": "no-store" } },
            );
          this.state.phase = "active";
          this.state.desiredActive = true;
          await this.save();
          return Response.json(this.state);
        }
        return unavailable("not_found", 404);
      } finally {
        this.controlling = false;
      }
    }
    if (
      this.state.phase !== "active" ||
      !this.validLease() ||
      !this.ctx.container!.running
    )
      return unavailable("candidate_not_active");
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.inFlight.add(done);
    const finish = () => {
      this.inFlight.delete(done);
      complete();
    };
    this.ctx.waitUntil(done);
    try {
      // Exactly one forward. Never replay an ambiguous business request on an
      // upstream error or automatically fail it over to an old database.
      if (this.env.SERVICE_KIND === "source-site") {
        const url = new URL(request.url);
        const host = [
          "stonegatejunkremoval.com",
          "www.stonegatejunkremoval.com",
        ].includes(url.hostname)
          ? url.hostname
          : (request.headers.get("x-migration-preview-host") ??
            "stonegatejunkremoval.com");
        if (
          ![
            "stonegatejunkremoval.com",
            "www.stonegatejunkremoval.com",
          ].includes(host)
        ) {
          finish();
          return unavailable("unknown_preview_host", 421);
        }
        url.hostname = host;
        request = new Request(url, request);
      }
      const response = await this.ctx
        .container!.getTcpPort(8080)
        .fetch(upstreamRequest(request));
      const output = trackedResponse(response, finish);
      if (this.env.OPERATION_MODE === "production")
        output.headers.set("x-stonegate-hosting", "cloudflare");
      return output;
    } catch {
      finish();
      return unavailable("upstream_response_lost", 502);
    }
  }
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const url = new URL(request.url);
    const control = url.pathname.startsWith("/__gateway/");
    const production = env.OPERATION_MODE === "production";
    if (production && env.SERVICE_KIND !== "source-site")
      return unavailable("invalid_production_service");
    const publicHost =
      production &&
      ["stonegatejunkremoval.com", "www.stonegatejunkremoval.com"].includes(
        url.hostname,
      );
    if (
      (!publicHost || control) &&
      !authorized(request, env.MIGRATION_PROBE_TOKEN)
    )
      return unavailable("unauthorized", 401);
    if (
      (!publicHost && url.hostname !== env.GATEWAY_HOST) ||
      url.protocol !== "https:"
    )
      return unavailable("unknown_host", 421);
    // Preserve the existing Render custom-domain canonical redirect.
    if (
      publicHost &&
      !control &&
      url.hostname === "www.stonegatejunkremoval.com"
    ) {
      url.hostname = "stonegatejunkremoval.com";
      return new Response(null, {
        status: 301,
        headers: { location: url.href, "cache-control": "no-store" },
      });
    }
    if (
      control &&
      (url.search ||
        !(
          (request.method === "GET" && url.pathname === "/__gateway/status") ||
          (request.method === "POST" &&
            [
              "/__gateway/warm",
              "/__gateway/activate",
              "/__gateway/drain",
            ].includes(url.pathname))
        ))
    )
      return unavailable("not_found", 404);
    if (
      !control &&
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        request.method,
      )
    )
      return unavailable("method_not_allowed", 405);
    if (
      !production &&
      Date.now() >= expiresAt &&
      !["/__gateway/drain", "/__gateway/status"].includes(url.pathname)
    )
      return unavailable("trial_expired", 410);
    try {
      return await env.HTTP.getByName("http-gateway-v1", {
        locationHint: "enam",
      }).fetch(request);
    } catch {
      return unavailable();
    }
  },
} satisfies ExportedHandler<GatewayEnv>;
