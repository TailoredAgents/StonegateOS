// Retains the existing Render API origin after application handoff. This process
// has no database or provider credentials and never retries an upstream request.
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const methods = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
function cleanHeaders(input, request = false) {
  const blocked = new Set(hopHeaders);
  for (const value of String(input.connection ?? "").split(","))
    blocked.add(value.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(input).filter(
      ([name]) =>
        !blocked.has(name.toLowerCase()) &&
        (!request ||
          !/^(?:host$|forwarded$|x-real-ip$|x-forwarded-|cf-|x-migration-|x-stonegate-gateway-)/i.test(
            name,
          )),
    ),
  );
}
function reject(response, status, error) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ error }));
}

export function createForwarder({
  target,
  token,
  clientIpHeader,
  ingressToken,
  timeoutMs = 120000,
  allowLoopback = false,
}) {
  const origin = new URL(target);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !(
      origin.protocol === "https:" ||
      (allowLoopback &&
        origin.protocol === "http:" &&
        origin.hostname === "127.0.0.1")
    ) ||
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 256 ||
    (clientIpHeader && clientIpHeader !== "cf-connecting-ip") ||
    (ingressToken !== undefined &&
      (typeof ingressToken !== "string" || ingressToken.length < 32)) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 120000
  )
    throw Error("INVALID_FORWARDER_CONFIGURATION");
  const transport = origin.protocol === "https:" ? https : http;
  const agent = new transport.Agent({
    keepAlive: true,
    maxSockets: 128,
    maxFreeSockets: 16,
  });
  const pending = new Set();
  let accepting = true,
    stopped = false;
  const server = http.createServer(
    { maxHeaderSize: 32768 },
    (request, response) => {
      if (ingressToken) {
        // This health response describes only the isolated ingress test process.
        if (request.method === "GET" && request.url === "/_forwarder/healthz") {
          response.writeHead(200, { "cache-control": "no-store" });
          response.end("ingress-fixture");
          return;
        }
        const supplied = String(
          request.headers["x-migration-ingress-key"] ?? "",
        );
        if (
          supplied.length > 256 ||
          !timingSafeEqual(
            createHash("sha256").update(supplied).digest(),
            createHash("sha256").update(ingressToken).digest(),
          )
        ) {
          reject(response, 401, "unauthorized_ingress_fixture");
          return;
        }
      }
      if (!accepting) {
        reject(response, 503, "forwarder_draining");
        return;
      }
      if (!methods.has(request.method)) {
        reject(response, 405, "method_not_allowed");
        return;
      }
      const raw = request.url ?? "";
      let destination;
      try {
        destination = new URL(raw, origin);
      } catch {
        reject(response, 400, "invalid_target");
        return;
      }
      // Reject normalization, absolute URLs and control paths before injecting the
      // forwarding credential. Preserve the original encoded query and body.
      if (
        !raw.startsWith("/api/") ||
        destination.origin !== origin.origin ||
        destination.pathname + destination.search !== raw ||
        !destination.pathname.startsWith("/api/")
      ) {
        reject(response, 404, "not_found");
        return;
      }
      let ip = clientIpHeader
        ? request.headers[clientIpHeader]
        : request.socket.remoteAddress;
      if (typeof ip === "string" && ip.startsWith("::ffff:")) ip = ip.slice(7);
      if (typeof ip !== "string" || !isIP(ip)) {
        reject(response, 400, "client_identity_unavailable");
        return;
      }
      const headers = cleanHeaders(request.headers, true);
      headers["x-migration-legacy-key"] = token;
      headers["x-migration-legacy-client-ip"] = ip;
      const upstream = transport.request(destination, {
        method: request.method,
        headers,
        agent,
      });
      pending.add(upstream);
      let upstreamResponse;
      const timer = setTimeout(() => {
        reject(response, 504, "upstream_result_unknown");
        upstream.destroy();
        upstreamResponse?.destroy();
      }, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        pending.delete(upstream);
      };
      upstream.once("response", (incoming) => {
        upstreamResponse = incoming;
        response.writeHead(incoming.statusCode, cleanHeaders(incoming.headers));
        incoming.once("error", () => response.destroy());
        incoming.pipe(response);
      });
      upstream.once("error", () => {
        reject(response, 502, "upstream_result_unknown");
        finish();
      });
      request.once("aborted", () => upstream.destroy());
      request.once("error", () => upstream.destroy());
      response.once("close", () => {
        if (!response.writableFinished) {
          upstream.destroy();
          upstreamResponse?.destroy();
        }
        finish();
      });
      response.once("finish", () => {
        finish();
        // A socket active when close() ran can become idle afterwards. Flush
        // its completed response, then close it instead of waiting for reuse.
        if (!accepting) request.socket.end();
      });
      request.pipe(upstream);
    },
  );
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  let drainPromise;
  function drain(graceMs = 25000) {
    if (drainPromise) return drainPromise;
    accepting = false;
    drainPromise = new Promise((resolve) => {
      let forced = false;
      const deadline = setTimeout(() => {
        forced = true;
        for (const request of pending) request.destroy();
        server.closeAllConnections();
      }, graceMs);
      server.close(() => {
        clearTimeout(deadline);
        agent.destroy();
        stopped = true;
        resolve({ stopped, forced, pending: pending.size });
      });
      server.closeIdleConnections();
    });
    return drainPromise;
  }
  return {
    server,
    drain,
    state: () => ({ accepting, stopped, pending: pending.size }),
  };
}

export async function runForwarder(environment = process.env) {
  const mode = environment.STONEGATE_FORWARDER_MODE;
  const target = environment.STONEGATE_FORWARDER_TARGET;
  const expected =
    mode === "fixture"
      ? "https://stonegate-http-gateway-validation.jeffrey-78e.workers.dev"
      : mode === "production"
        ? "https://stonegate-api-production.jeffrey-78e.workers.dev"
        : null;
  if (!expected || target !== expected)
    throw Error("UNAPPROVED_FORWARDER_TARGET");
  // Production ingress must be proved to overwrite this header before rollout.
  const instance = createForwarder({
    target,
    token: environment.STONEGATE_FORWARDER_TOKEN,
    clientIpHeader: mode === "production" ? "cf-connecting-ip" : undefined,
  });
  const port = Number(environment.PORT ?? 10000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("INVALID_PORT");
  await new Promise((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(
      port,
      mode === "fixture" ? "127.0.0.1" : "0.0.0.0",
      resolve,
    );
  });
  const stop = () =>
    void instance.drain().then(({ forced }) => process.exit(forced ? 1 : 0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  if (mode === "fixture") setTimeout(stop, 10 * 60 * 1000).unref();
  return instance;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runForwarder().catch(() => {
    console.error("forwarder_configuration_failed");
    process.exit(1);
  });
}
