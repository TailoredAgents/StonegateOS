import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/permissions";
import { getPlaidClient, plaidConfigured } from "@/lib/plaid";
import { nanoid } from "nanoid";
import type { CountryCode, Products } from "plaid";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const permissionError = await requirePermission(request, "payments.manage");
  if (permissionError) return permissionError as NextResponse;
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
      country_codes: ["US" as CountryCode],
      products: ["transactions" as Products],
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
