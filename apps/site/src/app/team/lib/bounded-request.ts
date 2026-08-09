export class BoundedRequestBodyError extends Error {
  readonly reason: "missing" | "invalid_length" | "too_large";

  constructor(reason: BoundedRequestBodyError["reason"]) {
    super(reason);
    this.name = "BoundedRequestBodyError";
    this.reason = reason;
  }
}

export async function readBoundedRequestBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new BoundedRequestBodyError("invalid_length");
  }
  const rawLength = request.headers.get("content-length");
  let declaredLength: number | null = null;
  if (rawLength !== null) {
    declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new BoundedRequestBodyError("invalid_length");
    }
    if (declaredLength > maximumBytes) {
      throw new BoundedRequestBodyError("too_large");
    }
  }
  if (!request.body) throw new BoundedRequestBodyError("missing");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BoundedRequestBodyError("too_large");
    }
    chunks.push(next.value);
  }
  if (declaredLength !== null && total !== declaredLength) {
    throw new BoundedRequestBodyError("invalid_length");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
