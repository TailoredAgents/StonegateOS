import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { generateQuoteScopeDraft } from "@/lib/ai";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";

const QuoteScopeDraftSchema = z.object({
  customerName: z.string().max(160).optional(),
  services: z.array(z.string().min(1)).min(1),
  total: z.number().nonnegative().optional(),
  roughNotes: z.string().max(2000).optional(),
});

function fallbackScope(input: z.infer<typeof QuoteScopeDraftSchema>): string {
  const serviceText = input.services.join(", ");
  return [
    `Stonegate Junk Removal will complete the quoted scope for ${serviceText}.`,
    input.roughNotes?.trim() ? `Scope notes: ${input.roughNotes.trim()}` : null,
    "This includes loading, haul-away, disposal, and cleanup of the quoted items. Final pricing can change only if volume, access, weight, or materials differ from the quoted scope."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.write");
  if (permissionError) return permissionError;

  const parsed = QuoteScopeDraftSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const draft = await generateQuoteScopeDraft(parsed.data);
  return NextResponse.json({ ok: true, draft: draft ?? fallbackScope(parsed.data), aiGenerated: Boolean(draft) });
}
