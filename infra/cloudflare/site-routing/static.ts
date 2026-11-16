// Public build files only. Application data and the server action manifest are
// never stored under this prefix. This stays usable when HTML rolls back.
export async function preservedStatic(
  request: Request,
  bucket: R2Bucket,
): Promise<Response | null> {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/_next/static/")) return null;
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice("/_next/static/".length));
  } catch {
    return null;
  }
  if (
    !/^[a-zA-Z0-9_./@()~\[\]-]+$/.test(key) ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  )
    return null;
  const object = await bucket.get("site-static/" + key);
  if (!object) return null;
  const headers = new Headers({
    "content-type":
      object.httpMetadata?.contentType ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    etag: object.httpEtag,
    "x-content-sha256": object.customMetadata?.sha256 ?? "",
    "x-content-type-options": "nosniff",
  });
  const cached = (request.headers.get("if-none-match") ?? "")
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""));
  if (cached.includes("*") || cached.includes(object.httpEtag)) {
    await object.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-length", String(object.size));
  if (request.method === "HEAD") {
    await object.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}
