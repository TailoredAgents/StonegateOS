import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
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
  const account = process.env["TWILIO_ACCOUNT_SID"],
    token = process.env["TWILIO_AUTH_TOKEN"];
  if (typeof recording !== "string" || !/^RE[a-fA-F0-9]{32}$/.test(recording))
    return Response.json({ error: "No retained recording" }, { status: 404 });
  if (!account || !/^AC[a-fA-F0-9]{32}$/.test(account) || !token)
    return new Response(null, { status: 503 });
  await accessEvent(integration, "recording_download", "read");
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${recording}.mp3`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${account}:${token}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    return Response.json(
      { error: "Recording unavailable at provider" },
      { status: response.status === 404 ? 404 : 502 },
    );
  return new Response(response.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="call-${id}.mp3"`,
    },
  });
}
