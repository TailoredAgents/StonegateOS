import { eq } from "drizzle-orm";
import { conversationThreads } from "@/db";

export const GENERIC_INBOX_STAFF_SCOPE = "general" as const;

/**
 * Generic Inbox surfaces must never discover Partner financial conversations.
 * Financial threads are available only through the permissioned Partner Billing
 * workspace, so every generic Inbox query applies this SQL boundary.
 */
export function genericInboxThreadScopeCondition() {
  return eq(conversationThreads.staffScope, GENERIC_INBOX_STAFF_SCOPE);
}
