import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { syntheticCheck } from "./check";

class SyntheticContainer extends DurableObject<Env> {
  private busy = false;
  async fetch(request: Request): Promise<Response> {
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
          instance: { vcpu: 1, memoryMib: 2048, diskMb: 4000 },
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
        } catch {}
        await scheduler.wait(250);
      }
      if (!ready) throw Error("Synthetic container not ready");
      const process = await container.exec(["node", "-e", syntheticCheck], {
        cwd: "/app",
        stdout: "pipe",
        stderr: "ignore",
        env: {
          MIGRATION_SYNTHETIC_CONNECTION:
            this.env.MIGRATION_SYNTHETIC_CONNECTION,
          MIGRATION_MODE: url.pathname.endsWith("/delivery-check")
            ? "delivery"
            : url.pathname.startsWith("/outbox/")
              ? "outbox"
              : url.pathname.endsWith("/booking-check")
                ? "booking"
                : "api",
        },
        signal: AbortSignal.timeout(110000),
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
            .update(syntheticCheck)
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
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const route = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      !(
        /^\/(api|outbox)\/(check|stop)$/.test(route) ||
        route === "/api/booking-check" ||
        route === "/outbox/delivery-check"
      )
    )
      return Response.json({ error: "not_found" }, { status: 404 });
    const namespace = route.startsWith("/outbox/") ? env.OUTBOX : env.API;
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
