import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { providerProbe } from "./probe";

interface Env {
  TRIAL: DurableObjectNamespace<ProviderTrial>;
  MIGRATION_PROVIDER_CONFIG: string;
  MIGRATION_PROBE_TOKEN: string;
}
type Row = {
  phase: "dispatching" | "accepted" | "rejected" | "uncertain";
  at: string;
  result?: Record<string, unknown>;
};
export class ProviderTrial extends DurableObject<Env> {
  private busy = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const channel of ["sms", "email"]) {
        const row = await ctx.storage.get<Row>(channel);
        if (row?.phase === "dispatching")
          await ctx.storage.put(channel, { ...row, phase: "uncertain" });
      }
    });
  }
  private async snapshot() {
    const config = JSON.parse(this.env.MIGRATION_PROVIDER_CONFIG);
    return {
      runId: config.runId,
      providerCredentialsPresent:
        Object.keys(config.environment ?? {}).length > 0,
      preflight: (await this.ctx.storage.get("preflight")) ?? null,
      sms: (await this.ctx.storage.get("sms")) ?? null,
      email: (await this.ctx.storage.get("email")) ?? null,
      smsStatus: (await this.ctx.storage.get("sms-status")) ?? null,
      running: this.ctx.container!.running,
      image: this.ctx.container!.images.base,
    };
  }
  private async probe(action: string, sid?: string) {
    const container = this.ctx.container!;
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: { vcpu: 1, memoryMib: 1024, diskMb: 4000 },
        enableInternet: true,
      });
      this.ctx.waitUntil(container.monitor().catch(() => {}));
    }
    await container.setInactivityTimeout(120000);
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
    if (!ready) throw Error("Container unavailable");
    const process = await container.exec(
      ["node", "--import", "tsx", "-e", providerProbe],
      {
        cwd: "/app",
        stdout: "pipe",
        stderr: "ignore",
        env: {
          NODE_ENV: "production",
          DOTENV_CONFIG_PATH: "/dev/null",
          NODE_EXTRA_CA_CERTS:
            "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
          MIGRATION_PROVIDER_CONFIG: this.env.MIGRATION_PROVIDER_CONFIG,
          MIGRATION_PROVIDER_ACTION: action,
          ...(sid ? { MIGRATION_MESSAGE_SID: sid } : {}),
        },
        signal: AbortSignal.timeout(45000),
      },
    );
    const output = await process.output();
    if (output.stdout.byteLength > 8192) throw Error("Unexpected probe output");
    return JSON.parse(new TextDecoder().decode(output.stdout)) as Record<
      string,
      unknown
    >;
  }
  async fetch(request: Request) {
    const route = new URL(request.url).pathname;
    if (route === "/status") return Response.json(await this.snapshot());
    if (this.busy) return Response.json({ error: "busy" }, { status: 409 });
    this.busy = true;
    try {
      if (route === "/stop") {
        await this.ctx.container!.destroy();
        return Response.json(await this.snapshot());
      }
      const config = JSON.parse(this.env.MIGRATION_PROVIDER_CONFIG);
      if (
        config.purpose !== "authorized-migration-deliveries" ||
        !(Date.parse(config.expiresAt) > Date.now())
      )
        return Response.json(
          { error: "trial_expired_or_invalid" },
          { status: 403 },
        );
      const fingerprint = createHash("sha256")
        .update(this.env.MIGRATION_PROVIDER_CONFIG)
        .digest("hex");
      const pinned = await this.ctx.storage.get("configuration");
      if (pinned && pinned !== fingerprint)
        return Response.json(
          { error: "configuration_changed" },
          { status: 409 },
        );
      if (!pinned) await this.ctx.storage.put("configuration", fingerprint);
      if (route === "/preflight") {
        const result = await this.probe("preflight");
        await this.ctx.storage.put("preflight", {
          at: new Date().toISOString(),
          ...result,
        });
        return Response.json(result, { status: result.ok ? 200 : 503 });
      }
      if (route === "/sms-status") {
        const row = await this.ctx.storage.get<Row>("sms");
        const sid = row?.result?.providerMessageId;
        if (typeof sid !== "string")
          return Response.json({ error: "no_message_id" }, { status: 409 });
        const result = await this.probe("sms-status", sid);
        await this.ctx.storage.put("sms-status", {
          at: new Date().toISOString(),
          ...result,
        });
        return Response.json(result, { status: result.ok ? 200 : 503 });
      }
      const channel = route.slice("/send/".length);
      if (!["sms", "email"].includes(channel))
        return Response.json({ error: "not_found" }, { status: 404 });
      const existing = await this.ctx.storage.get<Row>(channel);
      if (existing)
        return Response.json(
          { error: "already_attempted", ...existing },
          { status: 409 },
        );
      const preflight = await this.ctx.storage.get<{ ok: boolean; at: string }>(
        "preflight",
      );
      if (!preflight?.ok || Date.now() - Date.parse(preflight.at) > 15 * 60000)
        return Response.json(
          { error: "fresh_preflight_required" },
          { status: 409 },
        );
      const row: Row = { phase: "dispatching", at: new Date().toISOString() };
      await this.ctx.storage.put(channel, row);
      try {
        const result = await this.probe(channel);
        row.phase =
          result.ok === true && result.certainty === "accepted"
            ? "accepted"
            : result.certainty === "rejected"
              ? "rejected"
              : "uncertain";
        row.result = result;
      } catch {
        row.phase = "uncertain";
      }
      await this.ctx.storage.put(channel, row);
      return Response.json(row, {
        status: row.phase === "accepted" ? 200 : 503,
      });
    } finally {
      this.busy = false;
    }
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const supplied = request.headers.get("authorization") ?? "";
    if (
      !env.MIGRATION_PROBE_TOKEN ||
      supplied.length > 512 ||
      !timingSafeEqual(
        createHash("sha256").update(supplied).digest(),
        createHash("sha256")
          .update("Bearer " + env.MIGRATION_PROBE_TOKEN)
          .digest(),
      )
    )
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const route = new URL(request.url).pathname;
    if (
      !(request.method === "GET" && route === "/status") &&
      !(
        request.method === "POST" &&
        [
          "/preflight",
          "/send/sms",
          "/send/email",
          "/sms-status",
          "/stop",
        ].includes(route)
      )
    )
      return Response.json({ error: "not_found" }, { status: 404 });
    try {
      const response = await env.TRIAL.getByName(
        "authorized-provider-trial-v1",
        { locationHint: "enam" },
      ).fetch(request);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set(
        "x-stonegate-provider-probe-sha256",
        createHash("sha256").update(providerProbe).digest("hex"),
      );
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return Response.json({ error: "provider_trial_failed" }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
