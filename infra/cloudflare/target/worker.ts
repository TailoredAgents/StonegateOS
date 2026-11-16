import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { targetCheck } from "./check";

interface TargetEnv {
  MIGRATION_TARGET_CONNECTION: string;
  MIGRATION_PROBE_TOKEN: string;
  TARGET_DATABASE: DurableObjectNamespace<TargetReadinessValidation>;
}

export class TargetReadinessValidation extends DurableObject<TargetEnv> {
  private busy = false;
  async fetch(request: Request): Promise<Response> {
    if (this.busy)
      return Response.json({ error: "probe_running" }, { status: 409 });
    this.busy = true;
    try {
      const container = this.ctx.container!;
      if (new URL(request.url).pathname === "/stop") {
        await container.destroy();
        return Response.json({ stopped: true });
      }
      if (!this.env.MIGRATION_TARGET_CONNECTION)
        throw new Error("Missing target read-only credentials");
      if (!container.running) {
        container.start({
          image: container.images.base,
          instance: { vcpu: 1, memoryMib: 2048, diskMb: 4000 },
          enableInternet: true,
        });
        this.ctx.waitUntil(
          container.monitor().catch(() =>
            console.error(
              JSON.stringify({
                event: "database_validation_container_stopped",
              }),
            ),
          ),
        );
      }
      await container.setInactivityTimeout(60000);
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
        } catch {
          /* Retry diagnostic readiness only. */
        }
        await scheduler.wait(250);
      }
      if (!ready) throw new Error("Container not ready");
      const probe = await container.exec(["node", "-e", targetCheck], {
        cwd: "/app",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          MIGRATION_TARGET_CONNECTION: this.env.MIGRATION_TARGET_CONNECTION,
        },
        signal: AbortSignal.timeout(90000),
      });
      const result = await probe.output();
      if (result.stdout.byteLength === 0) {
        const diagnostic = new TextDecoder().decode(result.stderr);
        const code = diagnostic.includes("Cannot find module")
          ? "DRIVER_LOAD_FAILED"
          : diagnostic.includes("is not valid JSON")
            ? "CONFIGURATION_MISSING"
            : diagnostic.includes("Unexpected restore target")
              ? "WRONG_TARGET"
              : "PROBE_STARTUP_FAILED";
        return Response.json(
          { ok: false, code },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      return new Response(result.stdout, {
        status: result.exitCode === 0 ? 200 : 503,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-stonegate-probe-sha256": createHash("sha256")
            .update(targetCheck)
            .digest("hex"),
        },
      });
    } finally {
      this.busy = false;
    }
  }
}
export default {
  async fetch(request: Request, env: TargetEnv): Promise<Response> {
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
    ) {
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    const route = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/check", "/stop"].includes(route))
      return Response.json({ error: "not_found" }, { status: 404 });
    if (route !== "/stop" && Date.now() >= Date.parse("2026-11-22T22:00:00Z"))
      return Response.json({ error: "expired" }, { status: 410 });
    try {
      return await env.TARGET_DATABASE.getByName("target-readiness-v1", {
        locationHint: "enam",
      }).fetch(request);
    } catch {
      console.error(
        JSON.stringify({ event: "database_container_probe_failed" }),
      );
      return Response.json({ error: "probe_failed" }, { status: 503 });
    }
  },
} satisfies ExportedHandler<TargetEnv>;
