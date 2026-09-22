import type { NextRequest } from "next/server";
import {
  getPartnerServiceRates,
  mutatePartnerServiceRates,
} from "@/lib/partner-structured-rates-route";
type Context = { params: Promise<{ accountId: string }> };
export async function GET(
  request: NextRequest,
  context: Context,
): Promise<Response> {
  return getPartnerServiceRates(request, (await context.params).accountId);
}
export async function PATCH(
  request: NextRequest,
  context: Context,
): Promise<Response> {
  return mutatePartnerServiceRates(request, (await context.params).accountId);
}
