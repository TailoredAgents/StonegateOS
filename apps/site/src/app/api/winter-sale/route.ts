import { NextResponse } from "next/server";
import { WinterSaleSnapshotSchema } from "@myst-os/sdk";

export const dynamic = "force-dynamic";
export async function GET() {
  const base =
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    "http://localhost:3001";
  try {
    const response = await fetch(
      `${base.replace(/\/$/, "")}/api/public/winter-sale`,
      { cache: "no-store", signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) throw new Error("Unavailable");
    const payload: unknown = await response.json();
    const result = WinterSaleSnapshotSchema.safeParse(
      payload && typeof payload === "object" && "promotion" in payload
        ? payload.promotion
        : null,
    );
    return NextResponse.json(
      { promotion: result.success ? result.data : null },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { promotion: null },
      { headers: { "cache-control": "no-store" } },
    );
  }
}
