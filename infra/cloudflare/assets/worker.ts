import { createHash, timingSafeEqual } from "node:crypto";
interface AssetEnv {
  ASSETS: R2Bucket;
  ARCHIVE_TOKEN: string;
  EXPECTED_SHA256: string;
}
const key = "site-render-static-20261115.tar.gz";
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
