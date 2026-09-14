/**
 * Guarded deployment probe. Without --execute this prints the plan and does no I/O.
 *
 * Required environment when executing:
 *   QUOTE_PROXY_PROBE_SITE_ORIGIN=https://<deployed-site>
 *   QUOTE_PROXY_PROBE_DATABASE_URL=<read-only database connection URL>
 *   QUOTE_RATE_LIMIT_HMAC_SECRET=<same value deployed on Site and API>
 * Optional: QUOTE_PROXY_PROBE_API_ORIGIN=https://<deployed-api>
 *
 * Execution sends two ordinary GETs for independently verified nonexistent
 * quote candidates per origin: baseline, then a spoofed forwarding prefix.
 * The application writes its normal abuse-control counters; this script's DB
 * connection is forced read-only. It creates no quote, job, payment or message.
 * No IP, candidate token, key, key hash, database URL or response body is logged.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import postgres from "postgres";
import {
  quoteV2CandidateTokenRateLimitHash,
  quoteV2NetworkClass,
} from "../src/lib/quote-v2-http";

type ProbeTarget = { label: "site" | "api"; origin: URL };
type ProbeEvidence = {
  candidate_count: number;
  window_seconds: number;
  network_hash: string | null;
};

class ProbeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProbeFailure";
  }
}

function target(label: ProbeTarget["label"], value: string): ProbeTarget {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new ProbeFailure("invalid_origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new ProbeFailure("use_https_origin_without_credentials_or_path");
  return { label, origin };
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) throw new ProbeFailure("missing_response_body");
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) throw new ProbeFailure("unexpected_response_size");
      buffers.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(buffers).toString("utf8");
}

async function expectedNetworkHash(
  probeTarget: ProbeTarget,
  secret: string,
): Promise<string> {
  // The same public origin's Cloudflare trace identifies the actual ingress
  // client without trusting a forwarding header supplied by this script.
  const response = await fetch(new URL("/cdn-cgi/trace", probeTarget.origin), {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "text/plain" },
  });
  if (!response.ok) throw new ProbeFailure("same_origin_trace_unavailable");
  const trace = await readBoundedText(response);
  const fields = new Map(
    trace.split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
  );
  const address = fields.get("ip") ?? "";
  if (
    !isIP(address) ||
    fields.get("h") !== probeTarget.origin.hostname ||
    !fields.get("colo")
  )
    throw new ProbeFailure("same_origin_trace_not_verified");
  const network = quoteV2NetworkClass(address);
  if (!network) throw new ProbeFailure("client_network_not_supported");
  return createHmac("sha256", secret)
    .update(`quote-v2-rate-limit:network-class\0${network}`, "utf8")
    .digest("hex");
}

async function execute(): Promise<void> {
  const site = process.env["QUOTE_PROXY_PROBE_SITE_ORIGIN"]?.trim();
  const database = process.env["QUOTE_PROXY_PROBE_DATABASE_URL"]?.trim();
  const secret = process.env["QUOTE_RATE_LIMIT_HMAC_SECRET"]?.trim();
  if (!site || !database || !secret || secret.length < 32)
    throw new ProbeFailure("missing_probe_environment");
  const targets = [target("site", site)];
  const api = process.env["QUOTE_PROXY_PROBE_API_ORIGIN"]?.trim();
  if (api) targets.push(target("api", api));

  const db = postgres(database, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    ssl: { rejectUnauthorized: true },
    connection: {
      application_name: "stonegate_quote_proxy_network_probe",
      default_transaction_read_only: true,
      statement_timeout: 10000,
    },
    onnotice: () => undefined,
  });
  try {
    const [readOnly] =
      await db`select current_setting('transaction_read_only') as enabled`;
    if (readOnly?.["enabled"] !== "on")
      throw new ProbeFailure("database_read_only_not_enforced");

    for (const probeTarget of targets) {
      const expected = await expectedNetworkHash(probeTarget, secret);
      const observed: string[] = [];
      for (const variant of ["baseline", "spoofed_prefix"] as const) {
        const token = `probe_${randomBytes(32).toString("base64url")}`;
        const candidateHash = quoteV2CandidateTokenRateLimitHash(token, secret);
        const capabilityHash = createHash("sha256")
          .update(token, "utf8")
          .digest("hex");
        const [collision] = await db`
          select (
            exists (select 1 from quotes where share_token = ${token})
            or exists (select 1 from quote_capabilities where token_hash = ${capabilityHash})
            or exists (select 1 from quote_public_rate_limits
              where scope = 'read:candidate_token' and scope_key_hash = ${candidateHash})
          ) as present
        `;
        if (collision?.["present"] !== false)
          throw new ProbeFailure("candidate_not_verified_unused");
        const headers = new Headers({
          Accept: "application/json",
          "x-correlation-id": `quote-network-probe-${randomUUID()}`,
        });
        if (variant === "spoofed_prefix") {
          // Reserved documentation addresses: never a real person's address.
          headers.set("x-forwarded-for", "192.0.2.22, 198.51.100.33");
          headers.set("x-real-ip", "192.0.2.22");
          headers.set("cf-connecting-ip", "192.0.2.22");
        }
        const response = await fetch(
          new URL(`/api/public/quotes/${token}`, probeTarget.origin),
          {
            method: "GET",
            headers,
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(45000),
          },
        );
        await response.body?.cancel();
        if (response.status !== 404)
          throw new ProbeFailure(
            `probe_expected_not_found_received_${response.status}`,
          );

        // Both limiter dimensions commit in one transaction. xmin links this
        // unique candidate to the exact network row without a timestamp guess.
        // A concurrent later network update can remove that evidence; fail
        // inconclusive instead of attributing another request's bucket.
        const evidence = await db<ProbeEvidence[]>`
          select c.request_count as candidate_count, c.window_seconds,
                 n.scope_key_hash as network_hash
          from quote_public_rate_limits c
          left join quote_public_rate_limits n
            on n.xmin = c.xmin and n.scope = 'read:network'
            and n.window_start = c.window_start
            and n.window_seconds = c.window_seconds
          where c.scope = 'read:candidate_token'
            and c.scope_key_hash = ${candidateHash}
          limit 3
        `;
        const row = evidence[0];
        if (evidence.length !== 1 || !row?.network_hash)
          throw new ProbeFailure(
            "network_evidence_inconclusive_or_secret_mismatch",
          );
        if (row.candidate_count !== 1 || row.window_seconds !== 60)
          throw new ProbeFailure("unexpected_rate_limit_evidence");
        observed.push(row.network_hash);
        const matched = row.network_hash === expected;
        console.log(
          JSON.stringify({
            target: probeTarget.label,
            variant,
            responseStatus: response.status,
            clientNetworkMatched: matched,
            transactionEvidenceVerified: true,
          }),
        );
        if (!matched)
          throw new ProbeFailure(
            "configured_hops_do_not_select_observed_client_network",
          );
      }
      const stable =
        expected === (await expectedNetworkHash(probeTarget, secret));
      if (!stable) throw new ProbeFailure("client_egress_changed_during_probe");
      if (observed[0] !== observed[1])
        throw new ProbeFailure("spoofed_headers_changed_network_bucket");
      console.log(
        JSON.stringify({
          target: probeTarget.label,
          trustedClientNetworkVerified: true,
          spoofedHeadersIgnored: true,
          clientEgressStable: true,
        }),
      );
    }
  } finally {
    await db.end({ timeout: 5 });
  }
}

if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify({
      mode: "plan_only",
      networkRequests: 0,
      databaseQueries: 0,
      executeEffect:
        "Two nonexistent-quote GETs and two ingress-trace GETs per configured origin. Application abuse-control counters only; direct database access is read-only.",
      requiredEnvironment: [
        "QUOTE_PROXY_PROBE_SITE_ORIGIN",
        "QUOTE_PROXY_PROBE_DATABASE_URL",
        "QUOTE_RATE_LIMIT_HMAC_SECRET",
      ],
      optionalEnvironment: ["QUOTE_PROXY_PROBE_API_ORIGIN"],
    }),
  );
} else {
  try {
    await execute();
  } catch (error) {
    // Provider/database exceptions can contain secrets, SQL and network data.
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof ProbeFailure
            ? error.code
            : "probe_infrastructure_error",
      }),
    );
    process.exitCode = 1;
  }
}
