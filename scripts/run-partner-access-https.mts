import { createServer } from "node:https";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Disposable loopback TLS only. Safari/WebKit requires HTTPS for production
// Secure cookies and storage uploads. Never relax application cookies or TLS.
// Keep this workspace-specific path in sync with run-partner-access-local.mts.
const workspace = fileURLToPath(new URL("../", import.meta.url));
const directory = join(
  tmpdir(),
  `stonegate-partner-access-tls-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`,
);
const key = join(directory, "key.pem");
const cert = join(directory, "cert.pem");

if (process.argv[2] === "--clean") {
  rmSync(directory, { recursive: true, force: true });
  console.log("Local access TLS certificate removed.");
  process.exit(0);
}
if (process.argv[2] && process.argv[2] !== "--prepare") {
  throw new Error(
    "Use --prepare, --clean, or no argument to start the proxies.",
  );
}

function certificateReady(): boolean {
  if (!existsSync(key) || !existsSync(cert)) return false;
  try {
    execFileSync(
      "openssl",
      ["x509", "-checkend", "3600", "-noout", "-in", cert],
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

if (process.argv[2] === "--prepare") {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (!certificateReady()) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    chmodSync(key, 0o600);
    chmodSync(cert, 0o600);
  }
  console.log(`Local access TLS certificate ready: ${cert}`);
  process.exit(0);
}
if (!certificateReady()) {
  throw new Error(
    "Prepare local TLS before building or starting the apps: run this script with --prepare.",
  );
}

const tls = { key: readFileSync(key), cert: readFileSync(cert) };
function proxy(port: number, upstreamPort: number, application: boolean) {
  const server = createServer(tls, (incoming, outgoing) => {
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        path: incoming.url,
        method: incoming.method,
        // S3 signs the original Host and path. Preserve both through its proxy.
        headers: application
          ? {
              ...incoming.headers,
              host: "localhost:3112",
              "x-forwarded-host": "localhost:3112",
              "x-forwarded-proto": "https",
              "x-forwarded-for": "127.0.0.1",
            }
          : incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end("Local rehearsal service unavailable.");
    });
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("error", () => {
    console.error(`Local TLS proxy could not listen on loopback port ${port}.`);
    stop(1);
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Local ${application ? "access" : "storage"} TLS proxy ready on https://localhost:${port}`,
    ),
  );
  return server;
}
const servers = [proxy(3112, 3110, true), proxy(14567, 14566, false)];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  // Preserve the certificate until explicit --clean after the apps stop: the
  // API loads this trust anchor at startup and must keep trusting a proxy restart.
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
