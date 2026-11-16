/** Decode transport encoding before asserting the content a recipient reads. */
export function decodeMailBody(
  body: string,
  headers: Record<string, string[]>,
): string {
  const encoding = Object.entries(headers)
    .find(
      ([name]) => name.toLowerCase() === "content-transfer-encoding",
    )?.[1]?.[0]
    ?.trim()
    .toLowerCase();
  if (encoding === "base64")
    return Buffer.from(body, "base64").toString("utf8");
  if (encoding !== "quoted-printable") return body;
  const unfolded = body.replace(/=\r?\n/g, "");
  const bytes = unfolded.replace(/=([0-9a-f]{2})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return Buffer.from(bytes, "latin1").toString("utf8");
}
