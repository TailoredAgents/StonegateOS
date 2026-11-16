import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { downloadTwilioProviderRecording } from "@/lib/twilio-provider";
import {
  authenticateIntegration,
  accessEvent,
  requireOwnerPermissions,
} from "@/lib/agent-integration-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (request.headers.has("origin")) return new Response(null, { status: 403 });
  const integration = await authenticateIntegration(request);
  if (!integration?.tools.includes("records"))
    return new Response(null, { status: 401 });
  try {
    requireOwnerPermissions(integration, ["contacts.read", "messages.read"]);
  } catch {
    return new Response(null, { status: 403 });
  }
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return new Response(null, { status: 404 });
  const [row] = await getDb().execute(
    sql`select recording_sid from call_records where id=${id}::uuid and deleted_at is null`,
  );
  const recording = row?.["recording_sid"];
  if (typeof recording !== "string" || !/^RE[a-fA-F0-9]{32}$/.test(recording))
    return Response.json({ error: "No retained recording" }, { status: 404 });
  await accessEvent(integration, "recording_download", "read");
  const response = await downloadTwilioProviderRecording(recording);
  if (!response.ok)
    return Response.json(
      { error: "Recording unavailable at provider" },
      { status: response.status === 404 ? 404 : 502 },
    );
  return new Response(new Uint8Array(response.buffer), {
    headers: {
      "Content-Type": response.contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${id}-${response.filename}"`,
    },
  });
}
