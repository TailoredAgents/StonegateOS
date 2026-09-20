import type { NextRequest } from "next/server";
import {
  readOwnerAlertSettings,
  mutateOwnerAlerts,
} from "@/lib/partner-owner-alert-routes";
export const GET = readOwnerAlertSettings;
export const PATCH = (request: NextRequest) =>
  mutateOwnerAlerts(request, "settings");
