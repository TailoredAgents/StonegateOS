import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminRequest } from "../../../web/admin";
import { maybeAutopublishBlogPost } from "@/lib/seo/agent";

const RunSchema = z.object({
  force: z.boolean().optional()
});

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = RunSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await maybeAutopublishBlogPost({ force: parsed.data.force });
  return NextResponse.json({ ok: true, result });
}

