import { NextRequest } from "next/server";
import { z } from "zod";
import {
  authenticateIntegration,
  accessEvent,
  requireOwnerPermissions,
} from "@/lib/agent-integration-auth";
import { bindIntegrationContext } from "@/lib/agent-integration-context";
import { GET as readMedia } from "../../../../admin/inbox/messages/[messageId]/media/[index]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string; index: string }> },
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
  const values = await params;
  if (
    !z.string().uuid().safeParse(values.messageId).success ||
    !/^\d{1,2}$/.test(values.index)
  )
    return new Response(null, { status: 404 });
  await accessEvent(integration, "message_media_download", "read");
  const internal = new NextRequest(
    `https://stonegate-internal.invalid/api/admin/inbox/messages/${values.messageId}/media/${values.index}`,
    { headers: { "x-api-key": process.env["ADMIN_API_KEY"] ?? "" } },
  );
  bindIntegrationContext(internal, {
    integrationId: integration.id,
    ownerId: integration.owner_id,
    label: integration.name,
    permissions: ["messages.read"],
    mutationAllowed: false,
  });
  const response = await readMedia(internal, {
    params: Promise.resolve(values),
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
