import type { NextRequest } from "next/server";
import { requireTeamRequestPrincipal } from "@/app/api/team/auth";
import { handleChatRequest } from "@/app/api/chat/route";

export async function POST(request: NextRequest): Promise<Response> {
  // Authenticate and authorize before the shared chat handler parses input or
  // performs model/provider/API work.
  const auth = await requireTeamRequestPrincipal(request, {
    returnJson: true,
    permissions: "messages.read",
    flashError: "Please sign in again to use the agent.",
  });
  if (!auth.ok) return auth.response;

  return handleChatRequest(request, auth.principal);
}
