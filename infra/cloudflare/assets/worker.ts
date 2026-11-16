import { createHash, timingSafeEqual } from "node:crypto";
interface AssetEnv {
  ASSETS: R2Bucket;
  ARCHIVE_TOKEN: string;
  EXPECTED_SHA256: string;
}
const key = "site-render-static-20261115.tar.gz";
function staticKey(pathname: string) {
  if (!pathname.startsWith("/static/")) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(8));
  } catch {
    return null;
  }
  if (
    !/^[a-zA-Z0-9_./@()~\[\]-]+$/.test(relative) ||
    relative.startsWith("/") ||
    relative.split("/").some((x) => !x || x === "." || x === "..")
  )
    return null;
  return "site-static/" + relative;
}
async function boundedBody(request: Request) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!request.body) return null;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > 8 * 1024 * 1024) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export default {
  async fetch(request: Request, env: AssetEnv): Promise<Response> {
    const token = request.headers.get("authorization") ?? "";
    if (
      !env.ARCHIVE_TOKEN ||
      token.length > 512 ||
      !timingSafeEqual(
        createHash("sha256").update(token).digest(),
        createHash("sha256").update(`Bearer ${env.ARCHIVE_TOKEN}`).digest(),
      )
    )
      return new Response(null, { status: 401 });
    if (Date.now() >= Date.parse("2026-11-22T22:00:00Z"))
      return new Response(null, { status: 410 });
    const url = new URL(request.url);
    const objectKey = staticKey(url.pathname);
    if (objectKey && !url.search) {
      if (request.method === "PUT") {
        const expected = request.headers.get("x-content-sha256") ?? "";
        if (!/^[a-f0-9]{64}$/.test(expected))
          return new Response(null, { status: 400 });
        const data = await boundedBody(request);
        if (!data) return new Response(null, { status: 413 });
        const sha256 = createHash("sha256").update(data).digest("hex");
        if (sha256 !== expected) return new Response(null, { status: 422 });
        const existing = await env.ASSETS.head(objectKey);
        if (existing)
          return Response.json(
            {
              ok: existing.customMetadata?.sha256 === sha256,
              bytes: existing.size,
              sha256: existing.customMetadata?.sha256,
            },
            { status: existing.customMetadata?.sha256 === sha256 ? 200 : 409 },
          );
        const contentType = objectKey.endsWith(".js")
          ? "application/javascript; charset=utf-8"
          : objectKey.endsWith(".css")
            ? "text/css; charset=utf-8"
            : objectKey.endsWith(".woff2")
              ? "font/woff2"
              : objectKey.endsWith(".woff")
                ? "font/woff"
                : "application/octet-stream";
        const saved = await env.ASSETS.put(objectKey, data, {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType },
          customMetadata: { sha256 },
        });
        if (!saved) return new Response(null, { status: 412 });
        return Response.json({ ok: true, bytes: saved.size, sha256 });
      }
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const object = await env.ASSETS.get(objectKey);
      if (!object) return new Response(null, { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type":
            object.httpMetadata?.contentType ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-sha256": object.customMetadata?.sha256 ?? "",
        },
      });
    }
    if (new URL(request.url).pathname !== "/archive")
      return new Response(null, { status: 404 });
    if (request.method === "PUT") {
      if (!request.body) return new Response(null, { status: 400 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of request.body) {
        size += chunk.byteLength;
        if (size > 8 * 1024 * 1024) return new Response(null, { status: 413 });
        chunks.push(chunk);
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (sha256 !== env.EXPECTED_SHA256)
        return new Response(null, { status: 422 });
      await env.ASSETS.put(key, data, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: { sha256 },
      });
      return Response.json({ ok: true, bytes: size, sha256 });
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const object = await env.ASSETS.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": "application/gzip",
        "cache-control": "no-store",
        "x-content-sha256": object.customMetadata?.sha256 ?? "",
      },
    });
  },
} satisfies ExportedHandler<AssetEnv>;
