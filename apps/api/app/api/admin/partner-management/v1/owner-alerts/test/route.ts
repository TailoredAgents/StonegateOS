import type { NextRequest } from "next/server";
import { mutateOwnerAlerts } from "@/lib/partner-owner-alert-routes";
export const POST = (request: NextRequest) =>
  mutateOwnerAlerts(request, "test");
