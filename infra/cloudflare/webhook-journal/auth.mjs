import webhooks from "twilio/lib/webhooks/webhooks.js";
import { createHash } from "node:crypto";
export const maxBytes = 256 * 1024;
export async function verifiedForm(request, originalOrigin, secret) {
  if (
    request.method !== "POST" ||
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/x-www-form-urlencoded"
  )
    return { error: 415 };
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (encoding && encoding !== "identity") return { error: 415 };
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
    return { error: 413 };
  const signature = request.headers.get("x-twilio-signature") ?? "";
  if (!secret || signature.length !== 28) return { error: 403 };
  const chunks = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { error: 413 };
      }
      chunks.push(value);
    }
  const body = Buffer.concat(chunks);
  const params = Object.create(null);
  for (const [key, value] of new URLSearchParams(body.toString("utf8"))) {
    if (Object.hasOwn(params, key))
      params[key] = [
        ...(Array.isArray(params[key]) ? params[key] : [params[key]]),
        value,
      ];
    else params[key] = value;
  }
  const url = new URL(request.url);
  const externalUrl = originalOrigin + url.pathname + url.search;
  if (!webhooks.validateRequest(secret, signature, externalUrl, params))
    return { error: 403 };
  // Collapse byte-identical retries only. Distinct encodings/field orders are
  // retained, leaving business/provider ID reconciliation to the real handler.
  const bodySha = createHash("sha256").update(body).digest("hex");
  const identity = JSON.stringify(["POST", externalUrl, bodySha]);
  return {
    id: createHash("sha256").update(identity).digest("hex"),
    externalUrl,
    signature,
    body,
    bodySha,
  };
}
