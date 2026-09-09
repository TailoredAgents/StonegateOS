import { createServer } from "node:https";
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disposable loopback TLS only. Safari/WebKit rightly refuses production
// Secure cookies over HTTP, even on localhost. Never relax application cookies.
const directory = mkdtempSync(join(tmpdir(), "stonegate-partner-access-tls-"));
const key = join(directory, "key.pem"),
  cert = join(directory, "cert.pem");
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
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  { stdio: "ignore" },
);
const server = createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (incoming, outgoing) => {
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: 3110,
        path: incoming.url,
        method: incoming.method,
        headers: {
          ...incoming.headers,
          host: "localhost:3112",
          "x-forwarded-host": "localhost:3112",
          "x-forwarded-proto": "https",
          "x-forwarded-for": "127.0.0.1",
        },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end("Local application unavailable.");
    });
    incoming.pipe(upstream);
  },
);
server.listen(3112, "127.0.0.1", () =>
  console.log("Local access TLS proxy ready on https://localhost:3112"),
);
function stop() {
  server.close(() => {
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
