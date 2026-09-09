import { NextResponse, type NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, partnerDocuments, partnerDocumentAccessLogs } from "@/db";
import { createMediaReadUrl, getMediaStorageBucket } from "@/lib/media-storage";
import { requirePermission, resolvePermissionContext } from "@/lib/permissions";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";
const HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ accountId: string; documentId: string }> },
) {
  const denied = await requirePermission(request, "partners.commercial.read");
  if (denied) return denied;
  const parsed = z
    .object({ accountId: z.string().uuid(), documentId: z.string().uuid() })
    .safeParse(await context.params);
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: HEADERS },
    );
  const actor = await resolvePermissionContext(request);
  if (actor.source !== "team_session" || !actor.principalId)
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403, headers: HEADERS },
    );
  const db = getDb();
  const [document] = await db
    .select({
      key: partnerDocuments.storageObjectKey,
      bucket: partnerDocuments.storageBucket,
    })
    .from(partnerDocuments)
    .where(
      and(
        eq(partnerDocuments.id, parsed.data.documentId),
        eq(partnerDocuments.partnerAccountId, parsed.data.accountId),
        inArray(partnerDocuments.documentType, [
          "invoice",
          "receipt",
          "statement",
          "credit",
          "void",
          "refund",
          "quote",
        ]),
      ),
    )
    .limit(1);
  if (!document || document.bucket !== getMediaStorageBucket())
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: HEADERS },
    );
  const url = await createMediaReadUrl(document.key, 300);
  await db
    .insert(partnerDocumentAccessLogs)
    .values({
      partnerAccountId: parsed.data.accountId,
      partnerDocumentId: parsed.data.documentId,
      actorType: "staff",
      actorTeamMemberId: actor.principalId,
      action: "download",
      correlationId: readPortalV2CorrelationId(request.headers),
    });
  return NextResponse.json(
    { ok: true, url, expiresAt: new Date(Date.now() + 300_000).toISOString() },
    { headers: HEADERS },
  );
}
