/** The current report endpoint creates a complete, consistent snapshot in one
 * transaction. Check the returned artifact before offering a browser download. */
export async function downloadPartnerServiceReport(input: {
  query: string;
  format: "csv" | "pdf";
  fetcher?: typeof fetch;
}): Promise<Blob> {
  const params = new URLSearchParams(input.query);
  params.delete("cursor");
  params.delete("limit");
  params.set("format", input.format);
  const response = await (input.fetcher ?? fetch)(
    `/api/partners/portal/reports?${params}`,
    { cache: "no-store" },
  );
  const expected = input.format === "pdf" ? "application/pdf" : "text/csv";
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes(expected)
  ) {
    const payload = (await response.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
    } | null;
    if (
      payload &&
      ["report_too_large", "invalid_fields"].includes(String(payload.error)) &&
      typeof payload.message === "string"
    )
      throw new Error(payload.message.slice(0, 500));
    throw new Error(
      "The complete report could not be loaded. No partial file was downloaded.",
    );
  }
  const checksum = response.headers.get("x-content-sha256"),
    snapshot = response.headers.get("x-report-snapshot-sha256");
  if (
    !checksum ||
    !snapshot ||
    !/^[a-f0-9]{64}$/u.test(checksum) ||
    !/^[a-f0-9]{64}$/u.test(snapshot)
  )
    throw new Error(
      "The report snapshot could not be verified. Please try again.",
    );
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 10 * 1024 * 1024)
    throw new Error("This report is too large. Choose a shorter date range.");
  const actual = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== checksum)
    throw new Error("The report download was incomplete. No file was saved.");
  return new Blob([bytes], { type: expected });
}

/** Read-only compatibility for older statement-summary endpoints. */
export async function collectPartnerReportCsv(
  fetchPage: typeof fetch = fetch,
): Promise<string> {
  const chunks: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let header: string | null = null;
  let bytes = 0;
  for (let page = 0; page < 500; page += 1) {
    const query = new URLSearchParams({ format: "csv", limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetchPage(`/api/partners/portal/reports?${query}`, {
      cache: "no-store",
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("text/csv")
    ) {
      throw new Error(
        "The complete report could not be loaded. No partial file was downloaded.",
      );
    }
    const csv = await response.text();
    bytes += new TextEncoder().encode(csv).byteLength;
    if (bytes > 10 * 1024 * 1024) {
      throw new Error(
        "This report is too large for a browser download. Contact Stonegate for the full export.",
      );
    }
    const lineEnd = csv.indexOf("\n");
    const pageHeader = (lineEnd < 0 ? csv : csv.slice(0, lineEnd)).replace(
      /\r$/u,
      "",
    );
    if (header !== null && header !== pageHeader) {
      throw new Error(
        "The report changed during export. Refresh and try again.",
      );
    }
    header = pageHeader;
    chunks.push(page === 0 ? csv : lineEnd < 0 ? "" : csv.slice(lineEnd + 1));
    cursor = response.headers.get("x-next-cursor");
    if (!cursor)
      return chunks
        .filter(Boolean)
        .map((chunk) => chunk.replace(/\r?\n$/u, ""))
        .join("\r\n");
    if (cursor.length > 8_192 || seen.has(cursor)) {
      throw new Error(
        "The report could not be fully paginated. No partial file was downloaded.",
      );
    }
    seen.add(cursor);
  }
  throw new Error(
    "This report needs a larger export. Contact Stonegate for the full history.",
  );
}
