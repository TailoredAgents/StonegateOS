import { NextResponse } from "next/server";
import { activeWinterSale } from "@/lib/winter-sale";

export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json(
    { promotion: await activeWinterSale() },
    { headers: { "cache-control": "no-store" } },
  );
}
