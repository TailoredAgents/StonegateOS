import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../web/admin";
import { getPlaidClient, plaidConfigured } from "@/lib/plaid";
import { nanoid } from "nanoid";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!plaidConfigured()) {
    return NextResponse.json({ error: "plaid_not_configured" }, { status: 503 });
  }

  const plaid = getPlaidClient();
  if (!plaid) {
    return NextResponse.json({ error: "plaid_not_configured" }, { status: 503 });
  }

  try {
    const res = await plaid.linkTokenCreate({
      client_name: "Stonegate Owner HQ",
      language: "en",
      country_codes: ["US"],
      products: ["transactions"],
      user: {
        // single-tenant; use a unique but stable id
        client_user_id: `stonegate-${nanoid(12)}`
      }
    });
    return NextResponse.json({ ok: true, link_token: res.data.link_token });
  } catch (error) {
    console.error("[plaid] link_token_error", error);
    return NextResponse.json({ error: "plaid_link_token_failed" }, { status: 500 });
  }
}
