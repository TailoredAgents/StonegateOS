import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { verifiedForm } from "./auth.mjs";

interface JournalEnv {
  JOURNAL: DurableObjectNamespace<WebhookJournal>;
  RECEIVER: DurableObjectNamespace<ReplayFixture>;
  MIGRATION_PROBE_TOKEN: string;
  SYNTHETIC_TWILIO_TOKEN: string;
}
const originalOrigin = "https://migration-provider.invalid";
const expiresAt = Date.parse("2026-11-22T22:00:00Z");
const paths = new Set([
  "/api/webhooks/twilio/sms",
  "/api/webhooks/twilio/call-status",
  "/api/webhooks/twilio/dial-action",
]);
type Entry = Record<string, SqlStorageValue> & {
  sequence: number;
  id: string;
  state: string;
  external_url: string;
  body: ArrayBuffer;
  signature: string;
  attempts: number;
};
function reply(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
function allowed(request: Request, token: string) {
  const given = request.headers.get("x-migration-journal-key") ?? "";
  return (
    !!token &&
    given.length < 512 &&
    timingSafeEqual(
      createHash("sha256").update(given).digest(),
      createHash("sha256").update(token).digest(),
    )
  );
}

// No production callbacks reach this deployment. It accepts a synthetic signing
// secret and replays only to an in-account fixture binding, never the network.
export class WebhookJournal extends DurableObject<JournalEnv> {
  private replaying = false;
  constructor(ctx: DurableObjectState, env: JournalEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS journal (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','dispatching','delivered','uncertain')),
      received_at INTEGER NOT NULL, external_url TEXT NOT NULL,
      body BLOB NOT NULL, body_sha TEXT NOT NULL, signature TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, upstream_status INTEGER, reason TEXT
    )`);
    // A controller can die after the downstream commits. Such events must be
    // reconciled, not silently replayed after process recreation.
    ctx.storage.sql.exec(
      "UPDATE journal SET state='uncertain',reason='controller_restarted_during_dispatch' WHERE state='dispatching'",
    );
  }
  private status() {
    return reply({
      rows: this.ctx.storage.sql
        .exec(
          "SELECT sequence,id,state,received_at,body_sha,length(body) AS bytes,attempts,upstream_status,reason FROM journal ORDER BY sequence",
        )
        .toArray(),
    });
  }
  private async ingest(request: Request) {
    const entry = await verifiedForm(
      request,
      originalOrigin,
      this.env.SYNTHETIC_TWILIO_TOKEN,
    );
    if (entry.error) return reply({ error: "invalid_callback" }, entry.error);
    const sql = this.ctx.storage.sql;
    const existing = sql
      .exec("SELECT id FROM journal WHERE id=?", entry.id)
      .toArray();
    if (
      !existing.length &&
      sql.exec<{ count: number }>("SELECT count(*) AS count FROM journal").one()
        .count >= 500
    )
      return reply({ error: "trial_capacity_reached" }, 503);
    // SQLite's output gate holds the HTTP acknowledgement until this durable
    // write commits. No provider ACK is sent before durable acceptance.
    sql.exec(
      "INSERT INTO journal(id,state,received_at,external_url,body,body_sha,signature) VALUES(?,'pending',?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      entry.id,
      Date.now(),
      entry.externalUrl,
      entry.body,
      entry.bodySha,
      entry.signature,
    );
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
      headers: {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
        "x-migration-journal-id": entry.id,
      },
    });
  }
  private async replay(request: Request) {
    if (this.replaying) return reply({ error: "replay_in_progress" }, 409);
    if (
      this.ctx.storage.sql
        .exec("SELECT id FROM journal WHERE state='uncertain' LIMIT 1")
        .toArray().length
    )
      return reply({ error: "reconciliation_required" }, 409);
    this.replaying = true;
    let processed = 0;
    try {
      for (let i = 0; i < 50; i++) {
        const row = this.ctx.storage.sql
          .exec<Entry>(
            "SELECT * FROM journal WHERE state='pending' ORDER BY sequence LIMIT 1",
          )
          .toArray()[0];
        if (!row) break;
        this.ctx.storage.sql.exec(
          "UPDATE journal SET state='dispatching',attempts=attempts+1 WHERE id=? AND state='pending'",
          row.id,
        );
        let response: Response;
        try {
          response = await this.env.RECEIVER.getByName(
            request.headers.get("x-migration-trial-id")!,
          ).fetch(
            new Request(row.external_url, {
              method: "POST",
              body: row.body,
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-twilio-signature": row.signature,
                "x-migration-journal-id": row.id,
              },
              redirect: "manual",
              signal: AbortSignal.timeout(10000),
            }),
          );
          await response.body?.cancel();
        } catch {
          this.ctx.storage.sql.exec(
            "UPDATE journal SET state='uncertain',reason='response_lost' WHERE id=?",
            row.id,
          );
          processed++;
          break;
        }
        if (request.headers.get("x-migration-interrupt-after-commit") === "1") {
          // Deliberate acceptance test only: the fixture has committed while
          // the journal still says dispatching. abort forces DO recreation.
          this.ctx.abort(
            "Synthetic journal interruption after receiver commit",
          );
        }
        this.ctx.storage.sql.exec(
          "UPDATE journal SET state=?,upstream_status=?,reason=? WHERE id=?",
          response.ok ? "delivered" : "uncertain",
          response.status,
          response.ok ? null : "non_success_requires_reconciliation",
          row.id,
        );
        processed++;
        if (!response.ok) break;
      }
      return reply({ processed });
    } finally {
      this.replaying = false;
    }
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__journal/status") return this.status();
    if (url.pathname === "/__journal/replay") return this.replay(request);
    return this.ingest(request);
  }
}

export class ReplayFixture extends DurableObject<JournalEnv> {
  constructor(ctx: DurableObjectState, env: JournalEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,body_sha TEXT NOT NULL,url_sha TEXT NOT NULL,mode TEXT NOT NULL)",
    );
  }
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__fixture/status")
      return reply({
        receipts: this.ctx.storage.sql
          .exec("SELECT * FROM receipts ORDER BY id")
          .toArray(),
      });
    const verified = await verifiedForm(
      request,
      originalOrigin,
      this.env.SYNTHETIC_TWILIO_TOKEN,
    );
    if (
      verified.error ||
      request.headers.get("x-migration-journal-id") !== verified.id
    )
      return reply({ error: "replay_signature_rejected" }, 403);
    const form = new URLSearchParams(
      Buffer.from(verified.body).toString("utf8"),
    );
    const mode = form.get("FixtureMode") ?? "success";
    this.ctx.storage.sql.exec(
      "INSERT INTO receipts VALUES(?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1",
      verified.id,
      verified.bodySha,
      createHash("sha256").update(verified.externalUrl).digest("hex"),
      mode,
    );
    if (mode === "lost")
      throw Error("Synthetic response lost after durable receipt");
    if (mode === "reject") return reply({ rejected: true }, 503);
    return reply({ accepted: true });
  }
}

export default {
  async fetch(request: Request, env: JournalEnv): Promise<Response> {
    if (!allowed(request, env.MIGRATION_PROBE_TOKEN))
      return reply({ error: "unauthorized" }, 401);
    const run = request.headers.get("x-migration-trial-id") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(run))
      return reply({ error: "invalid_trial_id" }, 400);
    const url = new URL(request.url);
    const control = [
      "/__journal/status",
      "/__journal/replay",
      "/__fixture/status",
    ].includes(url.pathname);
    if (
      control
        ? !!url.search ||
          request.method !== (url.pathname.endsWith("/replay") ? "POST" : "GET")
        : !paths.has(url.pathname) || request.method !== "POST"
    )
      return reply({ error: "not_found" }, 404);
    if (Date.now() >= expiresAt && !url.pathname.endsWith("/status"))
      return reply({ error: "trial_expired" }, 410);
    try {
      if (url.pathname === "/__fixture/status")
        return await env.RECEIVER.getByName(run).fetch(request);
      return await env.JOURNAL.getByName(run).fetch(request);
    } catch {
      return reply({ error: "journal_unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<JournalEnv>;
