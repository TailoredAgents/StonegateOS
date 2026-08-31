export function buildReceiptStorageUploadHeaders(
  contentType: string,
  uploadHeaders: Record<string, unknown> | null,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(uploadHeaders ?? {})) {
    if (typeof value !== "string") continue;
    if (name.trim().toLowerCase() === "content-type") continue;
    headers.set(name, value);
  }
  headers.set("content-type", contentType);
  return headers;
}
