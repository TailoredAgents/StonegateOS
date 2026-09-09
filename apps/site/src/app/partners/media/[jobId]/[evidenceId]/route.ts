import { callPartnerApi } from "@/app/partners/lib/api";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

/** Resolve a fresh five-minute intent on every click, including without client JavaScript. */
export async function GET(_request: Request, context: { params: Promise<{ jobId: string; evidenceId: string }> }): Promise<Response> {
  const { jobId, evidenceId } = await context.params;
  const unavailable = () => new Response("This file is unavailable or your access has changed. Return to the job and try again. Need help? Email sales@stonegatejunkremoval.com or call 404-777-2631.", { status: 404, headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  if (!UUID.test(jobId) || !UUID.test(evidenceId)) return unavailable();
  try {
    const response = await callPartnerApi(`/api/portal/v2/jobs/${jobId}/proof`, { timeoutMs: 8_000, redirect: "manual" });
    if (!response.ok) return unavailable();
    const payload = await response.json() as { proof?: { media?: Array<{ id: string; status: string; downloadIntent?: { originalUrl?: string } | null }> } };
    const file = payload.proof?.media?.find((row) => row.id === evidenceId && row.status === "ready");
    if (!file?.downloadIntent?.originalUrl) return unavailable();
    const url = new URL(file.downloadIntent.originalUrl);
    if (url.protocol !== "https:" || url.username || url.password) return unavailable();
    return new Response(null, { status: 307, headers: { ...PRIVATE_HEADERS, Location: url.href } });
  } catch { return unavailable(); }
}
