import { z } from "zod";
import type { NextRequest } from "next/server";
import type { TeamPermission } from "@myst-os/sdk";

type Handler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;
type Module = Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", Handler>>;
export type CatalogTool = {
  name: string;
  description: string;
  path: string;
  method: keyof Module;
  permissions: TeamPermission[];
  approval: boolean;
  load: () => Promise<unknown>;
};
const tool = (
  name: string,
  description: string,
  path: string,
  method: keyof Module,
  permissions: TeamPermission[],
  approval: boolean,
  load: () => Promise<unknown>,
): CatalogTool => ({
  name,
  description,
  path,
  method,
  permissions,
  approval,
  load,
});
// Every target is static and reviewed. There is no user-supplied URL or method.
export const AGENT_CATALOG: CatalogTool[] = [
  tool(
    "promotional_sms_import",
    "Import existing exact texts; never rewrite. body: {action: dry_run or import,campaignId,sourceHash: SHA256 of source,records:[{contactId,body,sourceReference}],reviewHash?: returned by dry_run}. Run dry_run first, inspect every issue, then import same records/reviewHash with a new stable requestKey. Up to 2000 records, 1 MiB. Requires owner-delegated access; no dashboard upload needed.",
    "/api/admin/sms-campaigns/drafts",
    "POST",
    ["marketing.write", "contacts.read"],
    true,
    () => import("../../app/api/admin/sms-campaigns/drafts/route"),
  ),
  tool(
    "outreach_qualification_read",
    "Read current outreach qualification/version. query:{contactId}. Missing record means expectedVersion 0 for initial review.",
    "/api/admin/sms-campaigns/qualification",
    "GET",
    ["marketing.read", "contacts.read"],
    false,
    () => import("../../app/api/admin/sms-campaigns/qualification/route"),
  ),
  tool(
    "outreach_qualification_record",
    "Record reviewed evidence as owner delegate. body:{contactId,expectedVersion,qualification:past_customer|prior_inquiry|quote_only|unverified,facebookStatus:clear|excluded|uncertain,holds:string[],externalLastActivityAt:ISO|null,evidenceReference,reviewedAt:ISO}. Preserve actual findings; never invent consent or clear exclusions without evidence. Does not grant consent. Stable requestKey required.",
    "/api/admin/sms-campaigns/qualification",
    "POST",
    ["marketing.write", "contacts.write"],
    true,
    () => import("../../app/api/admin/sms-campaigns/qualification/route"),
  ),

  tool(
    "promotional_sms_drafts",
    "Read saved individual promotional drafts. query: campaignId, optional contactId, limit and offset. Copy is immutable and versioned.",
    "/api/admin/sms-campaigns/drafts",
    "GET",
    ["marketing.read", "contacts.read"],
    false,
    () => import("../../app/api/admin/sms-campaigns/drafts/route"),
  ),
  tool(
    "promotional_sms_preview",
    "Preview ONE saved draft with exact destination, Stonegate sender, wording, 30% offer and all eligibility holds. query: contactId,draftId,version. No send.",
    "/api/admin/sms-campaigns/single",
    "GET",
    ["marketing.read", "contacts.read", "messages.read"],
    false,
    () => import("../../app/api/admin/sms-campaigns/single/route"),
  ),
  tool(
    "promotional_sms_release",
    "Release ONLY ONE existing contact's exact saved promotional draft after owner approval. body: contactId,draftId,version,review and reviewExpiresAt copied verbatim from promotional_sms_preview. Stable requestKey required. Returns real thread/message IDs and queued status; never claims delivery before provider confirmation. All campaign and activity controls apply.",
    "/api/admin/sms-campaigns/single",
    "POST",
    [
      "marketing.write",
      "contacts.read",
      "messages.read",
      "messages.send",
      "policy.write",
    ],
    true,
    () => import("../../app/api/admin/sms-campaigns/single/route"),
  ),
  tool(
    "promotional_sms_status",
    "Read the original single-recipient release and CURRENT delivery/reconciliation state. query: contactId,draftId,version. Never sends or retries the provider.",
    "/api/admin/sms-campaigns/single/status",
    "GET",
    ["marketing.read", "contacts.read", "messages.read"],
    false,
    () => import("../../app/api/admin/sms-campaigns/single/status/route"),
  ),
  tool(
    "booking_availability",
    "Suggest available booking slots; body durationMinutes,windowDays,addressLine1,city,state,postalCode as needed. This only checks availability.",
    "/api/admin/booking/assist",
    "POST",
    ["bookings.manage"],
    false,
    () => import("../../app/api/admin/booking/assist/route"),
  ),
  tool(
    "booking_create",
    "Book an appointment after owner approval. body: contactId,propertyId,startAt (ISO with timezone),durationMinutes,appointmentType,services, optional notes/quotedTotalCents.",
    "/api/admin/booking/book",
    "POST",
    ["bookings.manage"],
    true,
    () => import("../../app/api/admin/booking/book/route"),
  ),
  tool(
    "merge_preview",
    "Read existing merge candidates/history; merges themselves require an attributed staff session in the Merge Queue.",
    "/api/admin/merge",
    "GET",
    ["contacts.merge"],
    false,
    () => import("../../app/api/admin/merge/route"),
  ),
  tool(
    "contacts_search",
    "Search CRM contacts; query q, contactId, limit, offset. Includes customer summaries.",
    "/api/admin/contacts",
    "GET",
    ["contacts.read", "quotes.read", "appointments.read"],
    false,
    () => import("../../app/api/admin/contacts/route"),
  ),
  tool(
    "contact_memory",
    "Read contact sales memory. params: contactId.",
    "/api/admin/contacts/[contactId]/sales-agent-memory",
    "GET",
    ["contacts.read", "quotes.read"],
    false,
    () =>
      import(
        "../../app/api/admin/contacts/[contactId]/sales-agent-memory/route"
      ),
  ),
  tool(
    "contact_context",
    "Read cross-channel customer facts. params: contactId.",
    "/api/admin/contacts/[contactId]/omni",
    "GET",
    [
      "contacts.read",
      "messages.read",
      "quotes.read",
      "appointments.read",
      "payments.read",
    ],
    false,
    () => import("../../app/api/admin/contacts/[contactId]/omni/route"),
  ),
  tool(
    "contact_photos",
    "Read quote photo references. params: contactId.",
    "/api/admin/contacts/[contactId]/instant-quote-photos",
    "GET",
    ["contacts.read", "quotes.read"],
    false,
    () =>
      import(
        "../../app/api/admin/contacts/[contactId]/instant-quote-photos/route"
      ),
  ),
  tool(
    "threads_list",
    "List inbox threads; query contactId, channel, limit, offset.",
    "/api/admin/inbox/threads",
    "GET",
    ["messages.read"],
    false,
    () => import("../../app/api/admin/inbox/threads/route"),
  ),
  tool(
    "thread_detail",
    "Read thread with messages. params: threadId. Use records for complete paginated history.",
    "/api/admin/inbox/threads/[threadId]",
    "GET",
    ["messages.read"],
    false,
    () => import("../../app/api/admin/inbox/threads/[threadId]/route"),
  ),
  tool(
    "quotes_list",
    "List customer quotes. query contactId, limit, offset.",
    "/api/quotes",
    "GET",
    ["quotes.read"],
    false,
    () => import("../../app/api/quotes/route"),
  ),
  tool(
    "quote_detail",
    "Read quote detail. params: id.",
    "/api/quotes/[id]",
    "GET",
    ["quotes.read"],
    false,
    () => import("../../app/api/quotes/[id]/route"),
  ),
  tool(
    "appointments_list",
    "Read appointments and jobs. query contactId, start, end.",
    "/api/appointments",
    "GET",
    ["appointments.read"],
    false,
    () => import("../../app/api/appointments/route"),
  ),
  tool(
    "appointment_payments",
    "Read customer payment history, not payment credentials. params: id.",
    "/api/appointments/[id]/payments",
    "GET",
    ["payments.read", "appointments.read"],
    false,
    () => import("../../app/api/appointments/[id]/payments/route"),
  ),
  tool(
    "schedule_summary",
    "Read current schedule and capacity.",
    "/api/admin/schedule/summary",
    "GET",
    ["appointments.read"],
    false,
    () => import("../../app/api/admin/schedule/summary/route"),
  ),
  tool(
    "campaigns_read",
    "Read campaign audience, readiness, review and delivery results. query campaignId, q.",
    "/api/admin/sms-campaigns",
    "GET",
    [
      "marketing.read",
      "contacts.read",
      "messages.read",
      "quotes.read",
      "appointments.read",
      "payments.read",
    ],
    false,
    () => import("../../app/api/admin/sms-campaigns/route"),
  ),
  tool(
    "contact_create",
    "Create a contact. body: firstName,lastName,phone,email and optional source/company. Does not grant marketing consent.",
    "/api/admin/contacts",
    "POST",
    ["contacts.write"],
    true,
    () => import("../../app/api/admin/contacts/route"),
  ),
  tool(
    "contact_update",
    "Update an existing contact after owner review. params: contactId; body supports firstName,lastName,email,phone,preferredContactMethod,source,salespersonMemberId. DNC and consent are not changed by this tool.",
    "/api/admin/contacts/[contactId]",
    "PATCH",
    ["contacts.write"],
    true,
    () => import("../../app/api/admin/contacts/[contactId]/route"),
  ),
  tool(
    "task_create",
    "Create a task or note. body: contactId,title,notes, optional dueAt,assignedTo,status (open/completed). Completed with no dueAt is a note.",
    "/api/admin/crm/tasks",
    "POST",
    ["contacts.write"],
    false,
    () => import("../../app/api/admin/crm/tasks/route"),
  ),
  tool(
    "task_update",
    "Update a task. params: taskId; body title,notes,dueAt,status as needed.",
    "/api/admin/crm/tasks/[taskId]",
    "PATCH",
    ["contacts.write"],
    false,
    () => import("../../app/api/admin/crm/tasks/[taskId]/route"),
  ),
  tool(
    "pipeline_update",
    "Update sales pipeline. params: contactId; body: stage and operation fields required by current API; expectedVersion where provided by reads.",
    "/api/admin/crm/pipeline/[contactId]",
    "PATCH",
    ["pipeline.write"],
    false,
    () => import("../../app/api/admin/crm/pipeline/[contactId]/route"),
  ),
  tool(
    "thread_update",
    "Update conversation status/assignment. params: threadId; body: changed inbox fields.",
    "/api/admin/inbox/threads/[threadId]",
    "PATCH",
    ["messages.write"],
    true,
    () => import("../../app/api/admin/inbox/threads/[threadId]/route"),
  ),
  tool(
    "thread_ensure",
    "Create or retrieve a channel thread. body: contactId,channel (sms/email/dm). Does not send.",
    "/api/admin/inbox/threads/ensure",
    "POST",
    ["messages.write", "contacts.read"],
    false,
    () => import("../../app/api/admin/inbox/threads/ensure/route"),
  ),
  tool(
    "message_draft",
    "Save a draft without sending. params: threadId; body: body and supported draft fields.",
    "/api/admin/inbox/threads/[threadId]/draft",
    "POST",
    ["messages.write"],
    false,
    () => import("../../app/api/admin/inbox/threads/[threadId]/draft/route"),
  ),
  tool(
    "message_send",
    "Propose exact message for owner approval. params: threadId; body: channel,body, optional subject. For promotional SMS use campaigns_command with verified eligibility; never use this to bypass campaign controls.",
    "/api/admin/inbox/threads/[threadId]/messages",
    "POST",
    ["messages.send"],
    true,
    () => import("../../app/api/admin/inbox/threads/[threadId]/messages/route"),
  ),
  tool(
    "call_start",
    "Propose a call through the existing staff bridge. body: contactId, optional agentMemberId/taskId. Does not deploy an autonomous voice bot.",
    "/api/admin/calls/start",
    "POST",
    ["calls.place"],
    true,
    () => import("../../app/api/admin/calls/start/route"),
  ),
  tool(
    "quote_create",
    "Prepare a quote using existing pricing. body follows Stonegate quote API; required contact/property/services and pricing inputs are validated by that API.",
    "/api/quotes",
    "POST",
    ["quotes.write"],
    true,
    () => import("../../app/api/quotes/route"),
  ),
  tool(
    "quote_update",
    "Update quote draft. params: id; body follows current quote API; expectedVersion when required.",
    "/api/quotes/[id]/draft",
    "PATCH",
    ["quotes.write"],
    true,
    () => import("../../app/api/quotes/[id]/draft/route"),
  ),
  tool(
    "quote_finalize",
    "Finalize a reviewed quote. params: id; body and expectedVersion follow current quote API.",
    "/api/quotes/[id]/finalize",
    "POST",
    ["quotes.write", "quotes.send"],
    true,
    () => import("../../app/api/quotes/[id]/finalize/route"),
  ),
  tool(
    "quote_send",
    "Send a finalized quote after exact action approval. params: id; body follows current quote send API.",
    "/api/quotes/[id]/send",
    "POST",
    ["quotes.write", "quotes.send", "messages.send"],
    true,
    () => import("../../app/api/quotes/[id]/send/route"),
  ),
  tool(
    "appointment_update",
    "Update/reschedule a booking under existing availability rules. params: id; body follows appointment API.",
    "/api/appointments/[id]",
    "PATCH",
    ["appointments.update"],
    true,
    () => import("../../app/api/appointments/[id]/route"),
  ),
  tool(
    "appointment_status",
    "Change job status. params: id; body: status and required lifecycle fields.",
    "/api/appointments/[id]/status",
    "POST",
    ["appointments.update"],
    true,
    () => import("../../app/api/appointments/[id]/status/route"),
  ),
  tool(
    "campaigns_command",
    "Manage campaign create/save/review/pause/resume/end/test/release and record existing consent evidence. Owner-delegated connections execute authorized work directly without dashboard approvals. Individual terms use deliveryMode: individual_drafts, audience: customers_and_leads, discountBasisPoints: 3000. Consent body: action:consent,contactId,status:granted|revoked,source,evidence,evidenceReference?,capturedAt:ISO,timeZone. Never infer consent merely from a phone number or prior inquiry.",
    "/api/admin/sms-campaigns",
    "POST",
    [
      "marketing.write",
      "contacts.read",
      "contacts.write",
      "messages.read",
      "messages.send",
      "policy.write",
    ],
    true,
    () => import("../../app/api/admin/sms-campaigns/route"),
  ),
];

export const ToolInputSchema = z
  .object({
    params: z.record(z.string().uuid()).default({}),
    query: z
      .record(z.union([z.string().max(500), z.number().finite(), z.boolean()]))
      .default({}),
    body: z.record(z.unknown()).default({}),
    requestKey: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/)
      .optional(),
    expectedVersion: z.string().max(200).optional(),
  })
  .strict();
export type ToolInput = z.infer<typeof ToolInputSchema>;
export function catalogTool(name: string) {
  const found = AGENT_CATALOG.find((t) => t.name === name);
  if (!found) throw new Error("Unknown tool");
  return found;
}
export function needsActionApproval(
  tool: CatalogTool,
  input: ToolInput,
  mode: "per_action" | "owner_delegated" = "per_action",
) {
  if (mode === "owner_delegated") return false;
  if (tool.name === "campaigns_command") {
    if (input.body["action"] === "consent")
      throw new Error(
        "Consent evidence must be entered by an authenticated owner in Stonegate",
      );
    return !["create", "save", "review", "pause"].includes(
      String(input.body["action"]),
    );
  }
  return tool.approval;
}
export async function invokeCatalogHandler(
  tool: CatalogTool,
  request: NextRequest,
  params: Record<string, string>,
) {
  const routeModule = (await tool.load()) as Module;
  const handler = routeModule[tool.method];
  if (!handler) throw new Error("Unsupported handler");
  return handler(request, { params: Promise.resolve(params) });
}
