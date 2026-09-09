import type { NextRequest } from "next/server";
import { partnerAccessWorkflowRetired } from "@/lib/partner-access-retirement";

export function POST(request: NextRequest): Response {
  return partnerAccessWorkflowRetired(request);
}
