# API Route Index (apps/api)

Generated from source. Fingerprint: `936fe00e4a527ba8`.

Routes discovered: 486

This index inventories exported HTTP handlers. It does not replace endpoint authentication, request-schema, response-schema, or side-effect documentation.

| Method(s) | Path | Handler |
| --- | --- | --- |
| POST | `/api/admin/agent/action-approvals` | `apps/api/app/api/admin/agent/action-approvals/route.ts` |
| POST | `/api/admin/agent/action-executions` | `apps/api/app/api/admin/agent/action-executions/route.ts` |
| GET | `/api/admin/appointments/source-summary` | `apps/api/app/api/admin/appointments/source-summary/route.ts` |
| GET | `/api/admin/audit/export` | `apps/api/app/api/admin/audit/export/route.ts` |
| GET | `/api/admin/audit` | `apps/api/app/api/admin/audit/route.ts` |
| GET, POST | `/api/admin/automation/lead` | `apps/api/app/api/admin/automation/lead/route.ts` |
| GET, POST | `/api/admin/automation` | `apps/api/app/api/admin/automation/route.ts` |
| POST | `/api/admin/booking/assist` | `apps/api/app/api/admin/booking/assist/route.ts` |
| POST | `/api/admin/booking/book` | `apps/api/app/api/admin/booking/book/route.ts` |
| GET | `/api/admin/calendar/feed` | `apps/api/app/api/admin/calendar/feed/route.ts` |
| DELETE | `/api/admin/calls/coaching/[callRecordId]` | `apps/api/app/api/admin/calls/coaching/[callRecordId]/route.ts` |
| GET | `/api/admin/calls/coaching` | `apps/api/app/api/admin/calls/coaching/route.ts` |
| GET | `/api/admin/calls/operations/[operationId]` | `apps/api/app/api/admin/calls/operations/[operationId]/route.ts` |
| GET, POST | `/api/admin/calls/reconciliation` | `apps/api/app/api/admin/calls/reconciliation/route.ts` |
| POST | `/api/admin/calls/reconciliation/sales-escalations` | `apps/api/app/api/admin/calls/reconciliation/sales-escalations/route.ts` |
| POST | `/api/admin/calls/start` | `apps/api/app/api/admin/calls/start/route.ts` |
| GET | `/api/admin/canvass/queue` | `apps/api/app/api/admin/canvass/queue/route.ts` |
| GET, POST, DELETE | `/api/admin/commissions/crew-pool-overrides` | `apps/api/app/api/admin/commissions/crew-pool-overrides/route.ts` |
| GET | `/api/admin/commissions/payout-runs/[payoutRunId]/export` | `apps/api/app/api/admin/commissions/payout-runs/[payoutRunId]/export/route.ts` |
| POST | `/api/admin/commissions/payout-runs/[payoutRunId]/lock` | `apps/api/app/api/admin/commissions/payout-runs/[payoutRunId]/lock/route.ts` |
| POST | `/api/admin/commissions/payout-runs/[payoutRunId]/mark-paid` | `apps/api/app/api/admin/commissions/payout-runs/[payoutRunId]/mark-paid/route.ts` |
| POST, DELETE | `/api/admin/commissions/payout-runs/[payoutRunId]/reimbursements` | `apps/api/app/api/admin/commissions/payout-runs/[payoutRunId]/reimbursements/route.ts` |
| GET | `/api/admin/commissions/payout-runs/[payoutRunId]/report` | `apps/api/app/api/admin/commissions/payout-runs/[payoutRunId]/report/route.ts` |
| GET, POST | `/api/admin/commissions/payout-runs` | `apps/api/app/api/admin/commissions/payout-runs/route.ts` |
| GET | `/api/admin/commissions/payroll-summary` | `apps/api/app/api/admin/commissions/payroll-summary/route.ts` |
| GET, PUT | `/api/admin/commissions/settings` | `apps/api/app/api/admin/commissions/settings/route.ts` |
| GET | `/api/admin/commissions/summary` | `apps/api/app/api/admin/commissions/summary/route.ts` |
| GET | `/api/admin/contacts/[contactId]/instant-quote-photos` | `apps/api/app/api/admin/contacts/[contactId]/instant-quote-photos/route.ts` |
| POST | `/api/admin/contacts/[contactId]/media-analysis/rebuild` | `apps/api/app/api/admin/contacts/[contactId]/media-analysis/rebuild/route.ts` |
| GET | `/api/admin/contacts/[contactId]/media-analysis` | `apps/api/app/api/admin/contacts/[contactId]/media-analysis/route.ts` |
| GET | `/api/admin/contacts/[contactId]/omni` | `apps/api/app/api/admin/contacts/[contactId]/omni/route.ts` |
| PATCH, DELETE | `/api/admin/contacts/[contactId]/properties/[propertyId]` | `apps/api/app/api/admin/contacts/[contactId]/properties/[propertyId]/route.ts` |
| POST | `/api/admin/contacts/[contactId]/properties` | `apps/api/app/api/admin/contacts/[contactId]/properties/route.ts` |
| GET, POST | `/api/admin/contacts/[contactId]/purge` | `apps/api/app/api/admin/contacts/[contactId]/purge/route.ts` |
| POST | `/api/admin/contacts/[contactId]/restore` | `apps/api/app/api/admin/contacts/[contactId]/restore/route.ts` |
| PATCH, DELETE | `/api/admin/contacts/[contactId]` | `apps/api/app/api/admin/contacts/[contactId]/route.ts` |
| POST | `/api/admin/contacts/[contactId]/sales-agent-memory/rebuild` | `apps/api/app/api/admin/contacts/[contactId]/sales-agent-memory/rebuild/route.ts` |
| GET | `/api/admin/contacts/[contactId]/sales-agent-memory` | `apps/api/app/api/admin/contacts/[contactId]/sales-agent-memory/route.ts` |
| POST | `/api/admin/contacts/[contactId]/sales-agent-next-action/rebuild` | `apps/api/app/api/admin/contacts/[contactId]/sales-agent-next-action/rebuild/route.ts` |
| GET, PATCH | `/api/admin/contacts/[contactId]/sales-agent-next-action` | `apps/api/app/api/admin/contacts/[contactId]/sales-agent-next-action/route.ts` |
| GET, POST | `/api/admin/contacts` | `apps/api/app/api/admin/contacts/route.ts` |
| GET | `/api/admin/crm/pipeline/[contactId]/movements` | `apps/api/app/api/admin/crm/pipeline/[contactId]/movements/route.ts` |
| PATCH | `/api/admin/crm/pipeline/[contactId]` | `apps/api/app/api/admin/crm/pipeline/[contactId]/route.ts` |
| GET | `/api/admin/crm/pipeline/audit` | `apps/api/app/api/admin/crm/pipeline/audit/route.ts` |
| DELETE | `/api/admin/crm/pipeline/presets/[presetId]` | `apps/api/app/api/admin/crm/pipeline/presets/[presetId]/route.ts` |
| GET, POST | `/api/admin/crm/pipeline/presets` | `apps/api/app/api/admin/crm/pipeline/presets/route.ts` |
| GET | `/api/admin/crm/pipeline` | `apps/api/app/api/admin/crm/pipeline/route.ts` |
| POST, PATCH | `/api/admin/crm/reminders/[taskId]` | `apps/api/app/api/admin/crm/reminders/[taskId]/route.ts` |
| POST | `/api/admin/crm/reminders` | `apps/api/app/api/admin/crm/reminders/route.ts` |
| PATCH, DELETE | `/api/admin/crm/tasks/[taskId]` | `apps/api/app/api/admin/crm/tasks/[taskId]/route.ts` |
| GET, POST | `/api/admin/crm/tasks` | `apps/api/app/api/admin/crm/tasks/route.ts` |
| GET | `/api/admin/db/status` | `apps/api/app/api/admin/db/status/route.ts` |
| POST | `/api/admin/eta/drafts/[draftId]/dismiss` | `apps/api/app/api/admin/eta/drafts/[draftId]/dismiss/route.ts` |
| POST | `/api/admin/eta/drafts/[draftId]/send` | `apps/api/app/api/admin/eta/drafts/[draftId]/send/route.ts` |
| GET | `/api/admin/eta/drafts` | `apps/api/app/api/admin/eta/drafts/route.ts` |
| POST | `/api/admin/eta/traccar/sync` | `apps/api/app/api/admin/eta/traccar/sync/route.ts` |
| POST | `/api/admin/expenses/[expenseId]/correct` | `apps/api/app/api/admin/expenses/[expenseId]/correct/route.ts` |
| POST | `/api/admin/expenses/[expenseId]/post` | `apps/api/app/api/admin/expenses/[expenseId]/post/route.ts` |
| GET | `/api/admin/expenses/[expenseId]/receipt` | `apps/api/app/api/admin/expenses/[expenseId]/receipt/route.ts` |
| PATCH | `/api/admin/expenses/[expenseId]` | `apps/api/app/api/admin/expenses/[expenseId]/route.ts` |
| POST | `/api/admin/expenses/[expenseId]/void` | `apps/api/app/api/admin/expenses/[expenseId]/void/route.ts` |
| GET | `/api/admin/expenses/capabilities` | `apps/api/app/api/admin/expenses/capabilities/route.ts` |
| POST | `/api/admin/expenses/captures/[captureId]/confirm` | `apps/api/app/api/admin/expenses/captures/[captureId]/confirm/route.ts` |
| GET | `/api/admin/expenses/captures/[captureId]/content` | `apps/api/app/api/admin/expenses/captures/[captureId]/content/route.ts` |
| POST | `/api/admin/expenses/captures/[captureId]/finalize` | `apps/api/app/api/admin/expenses/captures/[captureId]/finalize/route.ts` |
| GET, DELETE | `/api/admin/expenses/captures/[captureId]` | `apps/api/app/api/admin/expenses/captures/[captureId]/route.ts` |
| GET, POST | `/api/admin/expenses/captures` | `apps/api/app/api/admin/expenses/captures/route.ts` |
| GET | `/api/admin/expenses/categories` | `apps/api/app/api/admin/expenses/categories/route.ts` |
| GET, POST, PUT | `/api/admin/expenses/daily-ad-spend` | `apps/api/app/api/admin/expenses/daily-ad-spend/route.ts` |
| GET | `/api/admin/expenses/export` | `apps/api/app/api/admin/expenses/export/route.ts` |
| PATCH | `/api/admin/expenses/fixed-costs/[fixedCostId]` | `apps/api/app/api/admin/expenses/fixed-costs/[fixedCostId]/route.ts` |
| GET, POST | `/api/admin/expenses/fixed-costs` | `apps/api/app/api/admin/expenses/fixed-costs/route.ts` |
| GET | `/api/admin/expenses/operations` | `apps/api/app/api/admin/expenses/operations/route.ts` |
| GET | `/api/admin/expenses/overview` | `apps/api/app/api/admin/expenses/overview/route.ts` |
| POST | `/api/admin/expenses/queue-health` | `apps/api/app/api/admin/expenses/queue-health/route.ts` |
| GET, POST | `/api/admin/expenses` | `apps/api/app/api/admin/expenses/route.ts` |
| POST | `/api/admin/expenses/submissions/[expenseId]/review` | `apps/api/app/api/admin/expenses/submissions/[expenseId]/review/route.ts` |
| GET, POST | `/api/admin/expenses/submissions` | `apps/api/app/api/admin/expenses/submissions/route.ts` |
| GET | `/api/admin/expenses/summary` | `apps/api/app/api/admin/expenses/summary/route.ts` |
| GET, PUT | `/api/admin/expenses/vendor-rules` | `apps/api/app/api/admin/expenses/vendor-rules/route.ts` |
| POST | `/api/admin/facebook/diagnose-messenger-lookup` | `apps/api/app/api/admin/facebook/diagnose-messenger-lookup/route.ts` |
| POST | `/api/admin/google/ads/analyst/recommendations/apply/bulk` | `apps/api/app/api/admin/google/ads/analyst/recommendations/apply/bulk/route.ts` |
| POST | `/api/admin/google/ads/analyst/recommendations/apply` | `apps/api/app/api/admin/google/ads/analyst/recommendations/apply/route.ts` |
| POST | `/api/admin/google/ads/analyst/recommendations/bulk` | `apps/api/app/api/admin/google/ads/analyst/recommendations/bulk/route.ts` |
| GET | `/api/admin/google/ads/analyst/recommendations/events` | `apps/api/app/api/admin/google/ads/analyst/recommendations/events/route.ts` |
| GET, POST | `/api/admin/google/ads/analyst/recommendations` | `apps/api/app/api/admin/google/ads/analyst/recommendations/route.ts` |
| GET | `/api/admin/google/ads/analyst/reports/[id]` | `apps/api/app/api/admin/google/ads/analyst/reports/[id]/route.ts` |
| GET | `/api/admin/google/ads/analyst/reports` | `apps/api/app/api/admin/google/ads/analyst/reports/route.ts` |
| POST | `/api/admin/google/ads/analyst/run` | `apps/api/app/api/admin/google/ads/analyst/run/route.ts` |
| GET, POST | `/api/admin/google/ads/analyst/settings` | `apps/api/app/api/admin/google/ads/analyst/settings/route.ts` |
| GET | `/api/admin/google/ads/analyst/status` | `apps/api/app/api/admin/google/ads/analyst/status/route.ts` |
| GET | `/api/admin/google/ads/spend` | `apps/api/app/api/admin/google/ads/spend/route.ts` |
| GET | `/api/admin/google/ads/status` | `apps/api/app/api/admin/google/ads/status/route.ts` |
| GET | `/api/admin/google/ads/summary` | `apps/api/app/api/admin/google/ads/summary/route.ts` |
| POST | `/api/admin/google/ads/sync` | `apps/api/app/api/admin/google/ads/sync/route.ts` |
| POST, PUT | `/api/admin/inbox/export/jsonl` | `apps/api/app/api/admin/inbox/export/jsonl/route.ts` |
| POST | `/api/admin/inbox/facebook/backfill-names` | `apps/api/app/api/admin/inbox/facebook/backfill-names/route.ts` |
| GET | `/api/admin/inbox/failed-sends` | `apps/api/app/api/admin/inbox/failed-sends/route.ts` |
| GET, HEAD | `/api/admin/inbox/messages/[messageId]/media/[index]` | `apps/api/app/api/admin/inbox/messages/[messageId]/media/[index]/route.ts` |
| POST | `/api/admin/inbox/messages/[messageId]/retry` | `apps/api/app/api/admin/inbox/messages/[messageId]/retry/route.ts` |
| DELETE | `/api/admin/inbox/messages/[messageId]` | `apps/api/app/api/admin/inbox/messages/[messageId]/route.ts` |
| POST | `/api/admin/inbox/new-leads/[contactId]/acknowledge` | `apps/api/app/api/admin/inbox/new-leads/[contactId]/acknowledge/route.ts` |
| GET | `/api/admin/inbox/new-leads/next` | `apps/api/app/api/admin/inbox/new-leads/next/route.ts` |
| POST | `/api/admin/inbox/threads/[threadId]/draft` | `apps/api/app/api/admin/inbox/threads/[threadId]/draft/route.ts` |
| POST | `/api/admin/inbox/threads/[threadId]/messages` | `apps/api/app/api/admin/inbox/threads/[threadId]/messages/route.ts` |
| GET, PATCH | `/api/admin/inbox/threads/[threadId]` | `apps/api/app/api/admin/inbox/threads/[threadId]/route.ts` |
| POST | `/api/admin/inbox/threads/[threadId]/suggest` | `apps/api/app/api/admin/inbox/threads/[threadId]/suggest/route.ts` |
| POST | `/api/admin/inbox/threads/ensure` | `apps/api/app/api/admin/inbox/threads/ensure/route.ts` |
| GET, POST | `/api/admin/inbox/threads` | `apps/api/app/api/admin/inbox/threads/route.ts` |
| GET | `/api/admin/inbox/timeline` | `apps/api/app/api/admin/inbox/timeline/route.ts` |
| POST | `/api/admin/inbox/uploads` | `apps/api/app/api/admin/inbox/uploads/route.ts` |
| GET, DELETE | `/api/admin/instant-quotes/[id]` | `apps/api/app/api/admin/instant-quotes/[id]/route.ts` |
| GET | `/api/admin/instant-quotes` | `apps/api/app/api/admin/instant-quotes/route.ts` |
| GET | `/api/admin/merge-recovery/[ledgerId]/assessment` | `apps/api/app/api/admin/merge-recovery/[ledgerId]/assessment/route.ts` |
| GET, PATCH | `/api/admin/merge-suggestions/[suggestionId]` | `apps/api/app/api/admin/merge-suggestions/[suggestionId]/route.ts` |
| GET | `/api/admin/merge-suggestions` | `apps/api/app/api/admin/merge-suggestions/route.ts` |
| POST | `/api/admin/merge-suggestions/scan` | `apps/api/app/api/admin/merge-suggestions/scan/route.ts` |
| GET, POST | `/api/admin/merge` | `apps/api/app/api/admin/merge/route.ts` |
| GET | `/api/admin/meta/ads/summary` | `apps/api/app/api/admin/meta/ads/summary/route.ts` |
| POST | `/api/admin/meta/ads/sync` | `apps/api/app/api/admin/meta/ads/sync/route.ts` |
| GET | `/api/admin/openai/ads/status` | `apps/api/app/api/admin/openai/ads/status/route.ts` |
| POST | `/api/admin/outbound/accounts/backfill` | `apps/api/app/api/admin/outbound/accounts/backfill/route.ts` |
| POST | `/api/admin/outbound/bulk` | `apps/api/app/api/admin/outbound/bulk/route.ts` |
| POST | `/api/admin/outbound/disposition` | `apps/api/app/api/admin/outbound/disposition/route.ts` |
| POST | `/api/admin/outbound/draft` | `apps/api/app/api/admin/outbound/draft/route.ts` |
| POST | `/api/admin/outbound/import/preview` | `apps/api/app/api/admin/outbound/import/preview/route.ts` |
| POST | `/api/admin/outbound/import` | `apps/api/app/api/admin/outbound/import/route.ts` |
| GET | `/api/admin/outbound/queue` | `apps/api/app/api/admin/outbound/queue/route.ts` |
| POST | `/api/admin/outbound/start` | `apps/api/app/api/admin/outbound/start/route.ts` |
| POST | `/api/admin/outbox/dispatch` | `apps/api/app/api/admin/outbox/dispatch/route.ts` |
| POST | `/api/admin/partner-management/v1/account-merges/[caseId]/complete` | `apps/api/app/api/admin/partner-management/v1/account-merges/[caseId]/complete/route.ts` |
| GET | `/api/admin/partner-management/v1/account-merges` | `apps/api/app/api/admin/partner-management/v1/account-merges/route.ts` |
| GET, PATCH | `/api/admin/partner-management/v1/accounts/[accountId]/approval-rules/[ruleId]` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/approval-rules/[ruleId]/route.ts` |
| GET, POST | `/api/admin/partner-management/v1/accounts/[accountId]/approval-rules` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/approval-rules/route.ts` |
| GET | `/api/admin/partner-management/v1/accounts/[accountId]/billing/documents/[documentId]` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/billing/documents/[documentId]/route.ts` |
| GET | `/api/admin/partner-management/v1/accounts/[accountId]/billing/invoices/[invoiceId]/history` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/billing/invoices/[invoiceId]/history/route.ts` |
| GET, POST | `/api/admin/partner-management/v1/accounts/[accountId]/billing/reconciliation/[jobId]` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/billing/reconciliation/[jobId]/route.ts` |
| GET, POST | `/api/admin/partner-management/v1/accounts/[accountId]/billing` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/billing/route.ts` |
| PATCH | `/api/admin/partner-management/v1/accounts/[accountId]/cancellation-policy` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/cancellation-policy/route.ts` |
| POST | `/api/admin/partner-management/v1/accounts/[accountId]/close` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/close/route.ts` |
| POST | `/api/admin/partner-management/v1/accounts/[accountId]/enable` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/enable/route.ts` |
| POST | `/api/admin/partner-management/v1/accounts/[accountId]/merge` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/merge/route.ts` |
| GET | `/api/admin/partner-management/v1/accounts/[accountId]/quote-context` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/quote-context/route.ts` |
| POST | `/api/admin/partner-management/v1/accounts/[accountId]/reactivate` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/reactivate/route.ts` |
| POST | `/api/admin/partner-management/v1/accounts/[accountId]/recover-administrator` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/recover-administrator/route.ts` |
| PATCH | `/api/admin/partner-management/v1/accounts/[accountId]/scheduling-policy` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/scheduling-policy/route.ts` |
| GET, PATCH | `/api/admin/partner-management/v1/accounts/[accountId]/service-agreement` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/service-agreement/route.ts` |
| GET, PATCH | `/api/admin/partner-management/v1/accounts/[accountId]/service-rates` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/service-rates/route.ts` |
| POST | `/api/admin/partner-management/v1/accounts/[accountId]/suspend` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/suspend/route.ts` |
| GET, POST | `/api/admin/partner-management/v1/accounts/[accountId]/workflow` | `apps/api/app/api/admin/partner-management/v1/accounts/[accountId]/workflow/route.ts` |
| GET, POST | `/api/admin/partner-management/v1/accounts` | `apps/api/app/api/admin/partner-management/v1/accounts/route.ts` |
| GET | `/api/admin/partner-management/v1/applications` | `apps/api/app/api/admin/partner-management/v1/applications/route.ts` |
| POST | `/api/admin/partner-management/v1/billing-disputes/[requestId]/decision` | `apps/api/app/api/admin/partner-management/v1/billing-disputes/[requestId]/decision/route.ts` |
| GET | `/api/admin/partner-management/v1/billing-disputes/[requestId]` | `apps/api/app/api/admin/partner-management/v1/billing-disputes/[requestId]/route.ts` |
| GET | `/api/admin/partner-management/v1/billing-disputes` | `apps/api/app/api/admin/partner-management/v1/billing-disputes/route.ts` |
| POST | `/api/admin/partner-management/v1/cancellation-requests/[requestId]/decision` | `apps/api/app/api/admin/partner-management/v1/cancellation-requests/[requestId]/decision/route.ts` |
| GET | `/api/admin/partner-management/v1/cancellation-requests/[requestId]` | `apps/api/app/api/admin/partner-management/v1/cancellation-requests/[requestId]/route.ts` |
| GET | `/api/admin/partner-management/v1/cancellation-requests` | `apps/api/app/api/admin/partner-management/v1/cancellation-requests/route.ts` |
| POST | `/api/admin/partner-management/v1/change-requests/[requestId]/decision` | `apps/api/app/api/admin/partner-management/v1/change-requests/[requestId]/decision/route.ts` |
| GET | `/api/admin/partner-management/v1/change-requests/[requestId]` | `apps/api/app/api/admin/partner-management/v1/change-requests/[requestId]/route.ts` |
| GET | `/api/admin/partner-management/v1/change-requests` | `apps/api/app/api/admin/partner-management/v1/change-requests/route.ts` |
| GET | `/api/admin/partner-management/v1/commercial` | `apps/api/app/api/admin/partner-management/v1/commercial/route.ts` |
| PATCH | `/api/admin/partner-management/v1/domains/[domainId]/revoke` | `apps/api/app/api/admin/partner-management/v1/domains/[domainId]/revoke/route.ts` |
| PATCH | `/api/admin/partner-management/v1/domains/[domainId]/verify` | `apps/api/app/api/admin/partner-management/v1/domains/[domainId]/verify/route.ts` |
| GET, POST | `/api/admin/partner-management/v1/domains` | `apps/api/app/api/admin/partner-management/v1/domains/route.ts` |
| POST | `/api/admin/partner-management/v1/invitations/resend` | `apps/api/app/api/admin/partner-management/v1/invitations/resend/route.ts` |
| POST | `/api/admin/partner-management/v1/invitations/revoke` | `apps/api/app/api/admin/partner-management/v1/invitations/revoke/route.ts` |
| GET, POST | `/api/admin/partner-management/v1/invitations` | `apps/api/app/api/admin/partner-management/v1/invitations/route.ts` |
| GET | `/api/admin/partner-management/v1/join-requests` | `apps/api/app/api/admin/partner-management/v1/join-requests/route.ts` |
| POST | `/api/admin/partner-management/v1/location-reviews/[reviewId]/decision` | `apps/api/app/api/admin/partner-management/v1/location-reviews/[reviewId]/decision/route.ts` |
| GET | `/api/admin/partner-management/v1/location-reviews` | `apps/api/app/api/admin/partner-management/v1/location-reviews/route.ts` |
| PATCH | `/api/admin/partner-management/v1/memberships/[membershipId]/migration-review` | `apps/api/app/api/admin/partner-management/v1/memberships/[membershipId]/migration-review/route.ts` |
| PATCH | `/api/admin/partner-management/v1/memberships/[membershipId]/role` | `apps/api/app/api/admin/partner-management/v1/memberships/[membershipId]/role/route.ts` |
| PATCH | `/api/admin/partner-management/v1/memberships/[membershipId]` | `apps/api/app/api/admin/partner-management/v1/memberships/[membershipId]/route.ts` |
| PATCH | `/api/admin/partner-management/v1/memberships/[membershipId]/scope` | `apps/api/app/api/admin/partner-management/v1/memberships/[membershipId]/scope/route.ts` |
| GET | `/api/admin/partner-management/v1/memberships` | `apps/api/app/api/admin/partner-management/v1/memberships/route.ts` |
| GET | `/api/admin/partner-management/v1/operations` | `apps/api/app/api/admin/partner-management/v1/operations/route.ts` |
| POST | `/api/admin/partner-management/v1/owner-alerts/groups/[groupId]/opened` | `apps/api/app/api/admin/partner-management/v1/owner-alerts/groups/[groupId]/opened/route.ts` |
| POST | `/api/admin/partner-management/v1/owner-alerts/requests/[bookingId]/opened` | `apps/api/app/api/admin/partner-management/v1/owner-alerts/requests/[bookingId]/opened/route.ts` |
| GET, PATCH | `/api/admin/partner-management/v1/owner-alerts/settings` | `apps/api/app/api/admin/partner-management/v1/owner-alerts/settings/route.ts` |
| POST | `/api/admin/partner-management/v1/owner-alerts/test` | `apps/api/app/api/admin/partner-management/v1/owner-alerts/test/route.ts` |
| GET | `/api/admin/partner-management/v1/people` | `apps/api/app/api/admin/partner-management/v1/people/route.ts` |
| POST | `/api/admin/partner-management/v1/quarantine/[caseId]/resolve` | `apps/api/app/api/admin/partner-management/v1/quarantine/[caseId]/resolve/route.ts` |
| GET | `/api/admin/partner-management/v1/quarantine` | `apps/api/app/api/admin/partner-management/v1/quarantine/route.ts` |
| GET | `/api/admin/partner-management/v1/request-inbox/[kind]/[requestId]` | `apps/api/app/api/admin/partner-management/v1/request-inbox/[kind]/[requestId]/route.ts` |
| GET | `/api/admin/partner-management/v1/request-inbox` | `apps/api/app/api/admin/partner-management/v1/request-inbox/route.ts` |
| POST | `/api/admin/partner-management/v1/reschedule-requests/[requestId]/decision` | `apps/api/app/api/admin/partner-management/v1/reschedule-requests/[requestId]/decision/route.ts` |
| GET | `/api/admin/partner-management/v1/reschedule-requests/[requestId]` | `apps/api/app/api/admin/partner-management/v1/reschedule-requests/[requestId]/route.ts` |
| GET | `/api/admin/partner-management/v1/reschedule-requests` | `apps/api/app/api/admin/partner-management/v1/reschedule-requests/route.ts` |
| POST | `/api/admin/partner-management/v1/security/identities/[userId]/disable` | `apps/api/app/api/admin/partner-management/v1/security/identities/[userId]/disable/route.ts` |
| GET | `/api/admin/partner-management/v1/security/identities/[userId]` | `apps/api/app/api/admin/partner-management/v1/security/identities/[userId]/route.ts` |
| GET | `/api/admin/partner-management/v1/security` | `apps/api/app/api/admin/partner-management/v1/security/route.ts` |
| POST | `/api/admin/partner-management/v1/security/sessions/[sessionId]/revoke` | `apps/api/app/api/admin/partner-management/v1/security/sessions/[sessionId]/revoke/route.ts` |
| GET | `/api/admin/partner-management/v1/service-requests/[jobId]/arrival-preview` | `apps/api/app/api/admin/partner-management/v1/service-requests/[jobId]/arrival-preview/route.ts` |
| POST | `/api/admin/partner-management/v1/service-requests/[jobId]/price` | `apps/api/app/api/admin/partner-management/v1/service-requests/[jobId]/price/route.ts` |
| GET | `/api/admin/partner-management/v1/service-requests/[jobId]/resources` | `apps/api/app/api/admin/partner-management/v1/service-requests/[jobId]/resources/route.ts` |
| GET | `/api/admin/partner-management/v1/service-requests/[jobId]` | `apps/api/app/api/admin/partner-management/v1/service-requests/[jobId]/route.ts` |
| PATCH | `/api/admin/partner-management/v1/service-requests/[jobId]/visits/[visitId]` | `apps/api/app/api/admin/partner-management/v1/service-requests/[jobId]/visits/[visitId]/route.ts` |
| POST | `/api/admin/partner-management/v1/service-requests/[jobId]/visits/[visitId]/schedule` | `apps/api/app/api/admin/partner-management/v1/service-requests/[jobId]/visits/[visitId]/schedule/route.ts` |
| POST | `/api/admin/partner-management/v1/service-requests/[jobId]/visits` | `apps/api/app/api/admin/partner-management/v1/service-requests/[jobId]/visits/route.ts` |
| GET | `/api/admin/partner-management/v1/service-requests` | `apps/api/app/api/admin/partner-management/v1/service-requests/route.ts` |
| GET, PATCH | `/api/admin/partners/access-applications/[applicationId]` | `apps/api/app/api/admin/partners/access-applications/[applicationId]/route.ts` |
| GET | `/api/admin/partners/access-applications` | `apps/api/app/api/admin/partners/access-applications/route.ts` |
| POST | `/api/admin/partners/checkin` | `apps/api/app/api/admin/partners/checkin/route.ts` |
| GET, POST | `/api/admin/partners/invite-operations` | `apps/api/app/api/admin/partners/invite-operations/route.ts` |
| GET | `/api/admin/partners/portal-preview/[orgContactId]` | `apps/api/app/api/admin/partners/portal-preview/[orgContactId]/route.ts` |
| GET, POST | `/api/admin/partners/rates` | `apps/api/app/api/admin/partners/rates/route.ts` |
| POST | `/api/admin/partners/referral` | `apps/api/app/api/admin/partners/referral/route.ts` |
| GET | `/api/admin/partners` | `apps/api/app/api/admin/partners/route.ts` |
| GET, POST | `/api/admin/partners/staff-notifications/reconciliation` | `apps/api/app/api/admin/partners/staff-notifications/reconciliation/route.ts` |
| POST | `/api/admin/partners/touch` | `apps/api/app/api/admin/partners/touch/route.ts` |
| GET, POST, PATCH | `/api/admin/partners/users` | `apps/api/app/api/admin/partners/users/route.ts` |
| GET, POST | `/api/admin/payments/reconciliation` | `apps/api/app/api/admin/payments/reconciliation/route.ts` |
| POST | `/api/admin/plaid/exchange` | `apps/api/app/api/admin/plaid/exchange/route.ts` |
| POST | `/api/admin/plaid/link-token` | `apps/api/app/api/admin/plaid/link-token/route.ts` |
| GET | `/api/admin/plaid/status` | `apps/api/app/api/admin/plaid/status/route.ts` |
| POST | `/api/admin/plaid/sync` | `apps/api/app/api/admin/plaid/sync/route.ts` |
| GET, POST | `/api/admin/policy` | `apps/api/app/api/admin/policy/route.ts` |
| GET | `/api/admin/providers/health` | `apps/api/app/api/admin/providers/health/route.ts` |
| GET | `/api/admin/quotes/v2/operations` | `apps/api/app/api/admin/quotes/v2/operations/route.ts` |
| GET | `/api/admin/revenue/forecast` | `apps/api/app/api/admin/revenue/forecast/route.ts` |
| PATCH | `/api/admin/roles/[roleId]` | `apps/api/app/api/admin/roles/[roleId]/route.ts` |
| GET, POST | `/api/admin/roles` | `apps/api/app/api/admin/roles/route.ts` |
| GET | `/api/admin/sales/activity/export` | `apps/api/app/api/admin/sales/activity/export/route.ts` |
| GET | `/api/admin/sales/activity` | `apps/api/app/api/admin/sales/activity/route.ts` |
| GET, PATCH | `/api/admin/sales/autopilot` | `apps/api/app/api/admin/sales/autopilot/route.ts` |
| PATCH | `/api/admin/sales/autopilot/signature` | `apps/api/app/api/admin/sales/autopilot/signature/route.ts` |
| POST | `/api/admin/sales/disposition` | `apps/api/app/api/admin/sales/disposition/route.ts` |
| GET | `/api/admin/sales/queue` | `apps/api/app/api/admin/sales/queue/route.ts` |
| POST | `/api/admin/sales/reset` | `apps/api/app/api/admin/sales/reset/route.ts` |
| GET | `/api/admin/sales/scorecard` | `apps/api/app/api/admin/sales/scorecard/route.ts` |
| GET, PATCH | `/api/admin/sales/settings` | `apps/api/app/api/admin/sales/settings/route.ts` |
| POST | `/api/admin/sales/simulated-chat` | `apps/api/app/api/admin/sales/simulated-chat/route.ts` |
| POST | `/api/admin/sales/touch` | `apps/api/app/api/admin/sales/touch/route.ts` |
| GET | `/api/admin/schedule/summary` | `apps/api/app/api/admin/schedule/summary/route.ts` |
| GET | `/api/admin/scheduling/appointments/[appointmentId]/resources` | `apps/api/app/api/admin/scheduling/appointments/[appointmentId]/resources/route.ts` |
| GET, POST | `/api/admin/scheduling/resources` | `apps/api/app/api/admin/scheduling/resources/route.ts` |
| POST | `/api/admin/seo/posts/[postId]/publish` | `apps/api/app/api/admin/seo/posts/[postId]/publish/route.ts` |
| POST | `/api/admin/seo/posts/[postId]/review` | `apps/api/app/api/admin/seo/posts/[postId]/review/route.ts` |
| POST | `/api/admin/seo/run` | `apps/api/app/api/admin/seo/run/route.ts` |
| GET | `/api/admin/seo/status` | `apps/api/app/api/admin/seo/status/route.ts` |
| POST | `/api/admin/stripe/backfill` | `apps/api/app/api/admin/stripe/backfill/route.ts` |
| GET | `/api/admin/system/health` | `apps/api/app/api/admin/system/health/route.ts` |
| POST | `/api/admin/team/break-glass/exchange` | `apps/api/app/api/admin/team/break-glass/exchange/route.ts` |
| GET | `/api/admin/team/directory` | `apps/api/app/api/admin/team/directory/route.ts` |
| PATCH, DELETE | `/api/admin/team/members/[memberId]` | `apps/api/app/api/admin/team/members/[memberId]/route.ts` |
| GET, POST | `/api/admin/team/members` | `apps/api/app/api/admin/team/members/route.ts` |
| POST | `/api/admin/team/sessions/revoke` | `apps/api/app/api/admin/team/sessions/revoke/route.ts` |
| GET | `/api/admin/team/sessions` | `apps/api/app/api/admin/team/sessions/route.ts` |
| POST | `/api/admin/team/sessions/self/revoke` | `apps/api/app/api/admin/team/sessions/self/revoke/route.ts` |
| GET | `/api/admin/team/sessions/self` | `apps/api/app/api/admin/team/sessions/self/route.ts` |
| POST | `/api/admin/tools/contact` | `apps/api/app/api/admin/tools/contact/route.ts` |
| POST | `/api/admin/tools/quote-scope` | `apps/api/app/api/admin/tools/quote-scope/route.ts` |
| POST | `/api/admin/tools/quote` | `apps/api/app/api/admin/tools/quote/route.ts` |
| GET | `/api/admin/web/analytics/errors` | `apps/api/app/api/admin/web/analytics/errors/route.ts` |
| GET | `/api/admin/web/analytics/funnel` | `apps/api/app/api/admin/web/analytics/funnel/route.ts` |
| GET | `/api/admin/web/analytics/summary` | `apps/api/app/api/admin/web/analytics/summary/route.ts` |
| GET | `/api/admin/web/analytics/vitals` | `apps/api/app/api/admin/web/analytics/vitals/route.ts` |
| POST | `/api/appointment-media/[id]/complete` | `apps/api/app/api/appointment-media/[id]/complete/route.ts` |
| GET | `/api/appointment-media/[id]/content` | `apps/api/app/api/appointment-media/[id]/content/route.ts` |
| POST | `/api/appointment-media/[id]/restore` | `apps/api/app/api/appointment-media/[id]/restore/route.ts` |
| PATCH, DELETE | `/api/appointment-media/[id]` | `apps/api/app/api/appointment-media/[id]/route.ts` |
| PUT | `/api/appointment-media/[id]/upload` | `apps/api/app/api/appointment-media/[id]/upload/route.ts` |
| POST | `/api/appointments/[id]/attachments` | `apps/api/app/api/appointments/[id]/attachments/route.ts` |
| POST | `/api/appointments/[id]/convert` | `apps/api/app/api/appointments/[id]/convert/route.ts` |
| POST | `/api/appointments/[id]/eta-status` | `apps/api/app/api/appointments/[id]/eta-status/route.ts` |
| PUT | `/api/appointments/[id]/final-total` | `apps/api/app/api/appointments/[id]/final-total/route.ts` |
| POST | `/api/appointments/[id]/manual-payments` | `apps/api/app/api/appointments/[id]/manual-payments/route.ts` |
| GET | `/api/appointments/[id]/media/manage-options` | `apps/api/app/api/appointments/[id]/media/manage-options/route.ts` |
| GET | `/api/appointments/[id]/media` | `apps/api/app/api/appointments/[id]/media/route.ts` |
| POST | `/api/appointments/[id]/media/upload-intents` | `apps/api/app/api/appointments/[id]/media/upload-intents/route.ts` |
| POST | `/api/appointments/[id]/notes` | `apps/api/app/api/appointments/[id]/notes/route.ts` |
| POST | `/api/appointments/[id]/payment-attempts` | `apps/api/app/api/appointments/[id]/payment-attempts/route.ts` |
| GET | `/api/appointments/[id]/payments` | `apps/api/app/api/appointments/[id]/payments/route.ts` |
| POST | `/api/appointments/[id]/quote-follow-up` | `apps/api/app/api/appointments/[id]/quote-follow-up/route.ts` |
| PATCH | `/api/appointments/[id]/quoted-scope` | `apps/api/app/api/appointments/[id]/quoted-scope/route.ts` |
| PATCH | `/api/appointments/[id]` | `apps/api/app/api/appointments/[id]/route.ts` |
| POST | `/api/appointments/[id]/sold-by` | `apps/api/app/api/appointments/[id]/sold-by/route.ts` |
| POST | `/api/appointments/[id]/status` | `apps/api/app/api/appointments/[id]/status/route.ts` |
| POST, PATCH | `/api/appointments/[id]/tasks` | `apps/api/app/api/appointments/[id]/tasks/route.ts` |
| GET | `/api/appointments` | `apps/api/app/api/appointments/route.ts` |
| POST, OPTIONS | `/api/brush-quote` | `apps/api/app/api/brush-quote/route.ts` |
| GET | `/api/calendar/status` | `apps/api/app/api/calendar/status/route.ts` |
| GET, POST | `/api/calendar/webhook` | `apps/api/app/api/calendar/webhook/route.ts` |
| POST | `/api/chat` | `apps/api/app/api/chat/route.ts` |
| POST, OPTIONS | `/api/demo-quote` | `apps/api/app/api/demo-quote/route.ts` |
| GET | `/api/healthz` | `apps/api/app/api/healthz/route.ts` |
| POST, OPTIONS | `/api/junk-quote/availability` | `apps/api/app/api/junk-quote/availability/route.ts` |
| POST, OPTIONS | `/api/junk-quote/book` | `apps/api/app/api/junk-quote/book/route.ts` |
| POST, OPTIONS | `/api/junk-quote/hold` | `apps/api/app/api/junk-quote/hold/route.ts` |
| POST, OPTIONS | `/api/junk-quote` | `apps/api/app/api/junk-quote/route.ts` |
| POST | `/api/mobile/offline-media-queue-health` | `apps/api/app/api/mobile/offline-media-queue-health/route.ts` |
| POST | `/api/payments/[id]/attach` | `apps/api/app/api/payments/[id]/attach/route.ts` |
| POST | `/api/payments/[id]/detach` | `apps/api/app/api/payments/[id]/detach/route.ts` |
| GET | `/api/payments` | `apps/api/app/api/payments/route.ts` |
| POST | `/api/payments/square/return` | `apps/api/app/api/payments/square/return/route.ts` |
| POST | `/api/portal/bookings/[appointmentId]/cancel` | `apps/api/app/api/portal/bookings/[appointmentId]/cancel/route.ts` |
| GET, POST | `/api/portal/bookings` | `apps/api/app/api/portal/bookings/route.ts` |
| POST | `/api/portal/logout` | `apps/api/app/api/portal/logout/route.ts` |
| GET | `/api/portal/me` | `apps/api/app/api/portal/me/route.ts` |
| POST | `/api/portal/password` | `apps/api/app/api/portal/password/route.ts` |
| GET, POST | `/api/portal/properties` | `apps/api/app/api/portal/properties/route.ts` |
| GET | `/api/portal/rates` | `apps/api/app/api/portal/rates/route.ts` |
| GET | `/api/portal/v2/access-applications/[applicationId]` | `apps/api/app/api/portal/v2/access-applications/[applicationId]/route.ts` |
| POST | `/api/portal/v2/access-applications/[applicationId]/withdraw` | `apps/api/app/api/portal/v2/access-applications/[applicationId]/withdraw/route.ts` |
| GET | `/api/portal/v2/access-applications/requirements` | `apps/api/app/api/portal/v2/access-applications/requirements/route.ts` |
| GET, POST | `/api/portal/v2/access-applications` | `apps/api/app/api/portal/v2/access-applications/route.ts` |
| GET, PATCH | `/api/portal/v2/account-profile` | `apps/api/app/api/portal/v2/account-profile/route.ts` |
| POST | `/api/portal/v2/address-suggestions` | `apps/api/app/api/portal/v2/address-suggestions/route.ts` |
| POST | `/api/portal/v2/approval-requests/[requestId]/decision` | `apps/api/app/api/portal/v2/approval-requests/[requestId]/decision/route.ts` |
| GET | `/api/portal/v2/approval-requests/[requestId]` | `apps/api/app/api/portal/v2/approval-requests/[requestId]/route.ts` |
| GET | `/api/portal/v2/approval-requests` | `apps/api/app/api/portal/v2/approval-requests/route.ts` |
| POST | `/api/portal/v2/auth/magic-link/consume` | `apps/api/app/api/portal/v2/auth/magic-link/consume/route.ts` |
| POST | `/api/portal/v2/auth/magic-link/request` | `apps/api/app/api/portal/v2/auth/magic-link/request/route.ts` |
| GET | `/api/portal/v2/booking-drafts/[draftId]/availability` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/availability/route.ts` |
| POST, DELETE | `/api/portal/v2/booking-drafts/[draftId]/hold` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/hold/route.ts` |
| POST | `/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]/finalize` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]/finalize/route.ts` |
| DELETE | `/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/media/[mediaId]/route.ts` |
| GET | `/api/portal/v2/booking-drafts/[draftId]/media` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/media/route.ts` |
| POST | `/api/portal/v2/booking-drafts/[draftId]/media/upload-intents` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/media/upload-intents/route.ts` |
| GET, PATCH, DELETE | `/api/portal/v2/booking-drafts/[draftId]` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/route.ts` |
| POST | `/api/portal/v2/booking-drafts/[draftId]/submit` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/submit/route.ts` |
| POST | `/api/portal/v2/booking-drafts/[draftId]/validate` | `apps/api/app/api/portal/v2/booking-drafts/[draftId]/validate/route.ts` |
| GET, POST | `/api/portal/v2/booking-drafts` | `apps/api/app/api/portal/v2/booking-drafts/route.ts` |
| POST | `/api/portal/v2/bulk-imports/[importId]/commit` | `apps/api/app/api/portal/v2/bulk-imports/[importId]/commit/route.ts` |
| POST | `/api/portal/v2/bulk-imports/[importId]/retry` | `apps/api/app/api/portal/v2/bulk-imports/[importId]/retry/route.ts` |
| GET | `/api/portal/v2/bulk-imports/[importId]` | `apps/api/app/api/portal/v2/bulk-imports/[importId]/route.ts` |
| GET, POST | `/api/portal/v2/bulk-imports` | `apps/api/app/api/portal/v2/bulk-imports/route.ts` |
| GET | `/api/portal/v2/cancellation-policy` | `apps/api/app/api/portal/v2/cancellation-policy/route.ts` |
| POST | `/api/portal/v2/company-join-requests/[requestId]/withdraw` | `apps/api/app/api/portal/v2/company-join-requests/[requestId]/withdraw/route.ts` |
| GET | `/api/portal/v2/company-join-requests/eligible-accounts` | `apps/api/app/api/portal/v2/company-join-requests/eligible-accounts/route.ts` |
| GET, POST | `/api/portal/v2/company-join-requests` | `apps/api/app/api/portal/v2/company-join-requests/route.ts` |
| POST | `/api/portal/v2/documents/[documentId]/download-intent` | `apps/api/app/api/portal/v2/documents/[documentId]/download-intent/route.ts` |
| GET | `/api/portal/v2/documents` | `apps/api/app/api/portal/v2/documents/route.ts` |
| POST | `/api/portal/v2/invitations/[invitationId]` | `apps/api/app/api/portal/v2/invitations/[invitationId]/route.ts` |
| POST | `/api/portal/v2/invitations/accept` | `apps/api/app/api/portal/v2/invitations/accept/route.ts` |
| GET, POST | `/api/portal/v2/invitations` | `apps/api/app/api/portal/v2/invitations/route.ts` |
| GET, POST | `/api/portal/v2/invoices/[invoiceId]/dispute-requests` | `apps/api/app/api/portal/v2/invoices/[invoiceId]/dispute-requests/route.ts` |
| GET, POST | `/api/portal/v2/invoices/[invoiceId]/payment-link` | `apps/api/app/api/portal/v2/invoices/[invoiceId]/payment-link/route.ts` |
| GET | `/api/portal/v2/invoices` | `apps/api/app/api/portal/v2/invoices/route.ts` |
| GET, POST | `/api/portal/v2/jobs/[jobId]/additional-service` | `apps/api/app/api/portal/v2/jobs/[jobId]/additional-service/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/cancel` | `apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/change-requests` | `apps/api/app/api/portal/v2/jobs/[jobId]/change-requests/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/duplicate` | `apps/api/app/api/portal/v2/jobs/[jobId]/duplicate/route.ts` |
| GET, POST | `/api/portal/v2/jobs/[jobId]/messages` | `apps/api/app/api/portal/v2/jobs/[jobId]/messages/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/proof/[evidenceId]/finalize` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/[evidenceId]/finalize/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/proof/[evidenceId]/restore` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/[evidenceId]/restore/route.ts` |
| DELETE | `/api/portal/v2/jobs/[jobId]/proof/[evidenceId]` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/[evidenceId]/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/proof/packages` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/packages/route.ts` |
| PATCH | `/api/portal/v2/jobs/[jobId]/proof/requirements` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/requirements/route.ts` |
| GET | `/api/portal/v2/jobs/[jobId]/proof` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/route.ts` |
| DELETE | `/api/portal/v2/jobs/[jobId]/proof/share-links/[shareId]` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/share-links/[shareId]/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/proof/share-links` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/share-links/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/proof/upload-intents` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/upload-intents/route.ts` |
| PATCH | `/api/portal/v2/jobs/[jobId]/references` | `apps/api/app/api/portal/v2/jobs/[jobId]/references/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/reschedule-draft` | `apps/api/app/api/portal/v2/jobs/[jobId]/reschedule-draft/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/reschedule-requests/[requestId]/withdraw` | `apps/api/app/api/portal/v2/jobs/[jobId]/reschedule-requests/[requestId]/withdraw/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/reschedule` | `apps/api/app/api/portal/v2/jobs/[jobId]/reschedule/route.ts` |
| GET | `/api/portal/v2/jobs/[jobId]` | `apps/api/app/api/portal/v2/jobs/[jobId]/route.ts` |
| POST | `/api/portal/v2/jobs/[jobId]/visits/[visitId]/reschedule` | `apps/api/app/api/portal/v2/jobs/[jobId]/visits/[visitId]/reschedule/route.ts` |
| GET | `/api/portal/v2/jobs` | `apps/api/app/api/portal/v2/jobs/route.ts` |
| POST | `/api/portal/v2/join-requests/[requestId]` | `apps/api/app/api/portal/v2/join-requests/[requestId]/route.ts` |
| GET | `/api/portal/v2/join-requests` | `apps/api/app/api/portal/v2/join-requests/route.ts` |
| GET | `/api/portal/v2/locations/[locationId]/archive-impact` | `apps/api/app/api/portal/v2/locations/[locationId]/archive-impact/route.ts` |
| PUT | `/api/portal/v2/locations/[locationId]/favorite` | `apps/api/app/api/portal/v2/locations/[locationId]/favorite/route.ts` |
| POST | `/api/portal/v2/locations/[locationId]/merge` | `apps/api/app/api/portal/v2/locations/[locationId]/merge/route.ts` |
| POST | `/api/portal/v2/locations/[locationId]/restore` | `apps/api/app/api/portal/v2/locations/[locationId]/restore/route.ts` |
| GET, PATCH, DELETE | `/api/portal/v2/locations/[locationId]` | `apps/api/app/api/portal/v2/locations/[locationId]/route.ts` |
| GET | `/api/portal/v2/locations/export` | `apps/api/app/api/portal/v2/locations/export/route.ts` |
| POST | `/api/portal/v2/locations/imports/[importId]/commit` | `apps/api/app/api/portal/v2/locations/imports/[importId]/commit/route.ts` |
| GET | `/api/portal/v2/locations/imports/[importId]/corrections` | `apps/api/app/api/portal/v2/locations/imports/[importId]/corrections/route.ts` |
| GET | `/api/portal/v2/locations/imports/[importId]` | `apps/api/app/api/portal/v2/locations/imports/[importId]/route.ts` |
| POST | `/api/portal/v2/locations/imports/dry-run` | `apps/api/app/api/portal/v2/locations/imports/dry-run/route.ts` |
| GET, POST | `/api/portal/v2/locations` | `apps/api/app/api/portal/v2/locations/route.ts` |
| POST | `/api/portal/v2/locations/validate` | `apps/api/app/api/portal/v2/locations/validate/route.ts` |
| GET | `/api/portal/v2/me` | `apps/api/app/api/portal/v2/me/route.ts` |
| PATCH | `/api/portal/v2/members/[membershipId]` | `apps/api/app/api/portal/v2/members/[membershipId]/route.ts` |
| GET | `/api/portal/v2/members` | `apps/api/app/api/portal/v2/members/route.ts` |
| DELETE | `/api/portal/v2/notification-endpoints/[endpointId]` | `apps/api/app/api/portal/v2/notification-endpoints/[endpointId]/route.ts` |
| POST | `/api/portal/v2/notification-endpoints/[endpointId]/verify` | `apps/api/app/api/portal/v2/notification-endpoints/[endpointId]/verify/route.ts` |
| GET, POST | `/api/portal/v2/notification-endpoints` | `apps/api/app/api/portal/v2/notification-endpoints/route.ts` |
| GET, PUT | `/api/portal/v2/notification-preferences` | `apps/api/app/api/portal/v2/notification-preferences/route.ts` |
| POST | `/api/portal/v2/notifications/[notificationId]/read` | `apps/api/app/api/portal/v2/notifications/[notificationId]/read/route.ts` |
| POST | `/api/portal/v2/notifications/read-all` | `apps/api/app/api/portal/v2/notifications/read-all/route.ts` |
| GET | `/api/portal/v2/notifications` | `apps/api/app/api/portal/v2/notifications/route.ts` |
| GET, PATCH | `/api/portal/v2/onboarding-checklist` | `apps/api/app/api/portal/v2/onboarding-checklist/route.ts` |
| POST | `/api/portal/v2/onboarding/activation/complete` | `apps/api/app/api/portal/v2/onboarding/activation/complete/route.ts` |
| POST | `/api/portal/v2/onboarding/activation/inspect` | `apps/api/app/api/portal/v2/onboarding/activation/inspect/route.ts` |
| POST | `/api/portal/v2/onboarding/activation/resend` | `apps/api/app/api/portal/v2/onboarding/activation/resend/route.ts` |
| POST | `/api/portal/v2/onboarding/application/respond` | `apps/api/app/api/portal/v2/onboarding/application/respond/route.ts` |
| GET, PATCH | `/api/portal/v2/onboarding/application` | `apps/api/app/api/portal/v2/onboarding/application/route.ts` |
| POST | `/api/portal/v2/onboarding/application/submit` | `apps/api/app/api/portal/v2/onboarding/application/submit/route.ts` |
| POST | `/api/portal/v2/onboarding/application/withdraw` | `apps/api/app/api/portal/v2/onboarding/application/withdraw/route.ts` |
| POST | `/api/portal/v2/onboarding/email-challenges/consume` | `apps/api/app/api/portal/v2/onboarding/email-challenges/consume/route.ts` |
| POST | `/api/portal/v2/onboarding/email-challenges` | `apps/api/app/api/portal/v2/onboarding/email-challenges/route.ts` |
| POST | `/api/portal/v2/onboarding/email-change/confirm` | `apps/api/app/api/portal/v2/onboarding/email-change/confirm/route.ts` |
| POST | `/api/portal/v2/onboarding/password-recovery/complete` | `apps/api/app/api/portal/v2/onboarding/password-recovery/complete/route.ts` |
| POST | `/api/portal/v2/onboarding/password-recovery/request` | `apps/api/app/api/portal/v2/onboarding/password-recovery/request/route.ts` |
| GET | `/api/portal/v2/overview` | `apps/api/app/api/portal/v2/overview/route.ts` |
| POST | `/api/portal/v2/payment-intents/[paymentIntentId]/complete` | `apps/api/app/api/portal/v2/payment-intents/[paymentIntentId]/complete/route.ts` |
| GET | `/api/portal/v2/payment-intents/[paymentIntentId]` | `apps/api/app/api/portal/v2/payment-intents/[paymentIntentId]/route.ts` |
| POST | `/api/portal/v2/payment-intents` | `apps/api/app/api/portal/v2/payment-intents/route.ts` |
| GET, PATCH | `/api/portal/v2/personal-profile` | `apps/api/app/api/portal/v2/personal-profile/route.ts` |
| GET, PATCH | `/api/portal/v2/proof-requirements` | `apps/api/app/api/portal/v2/proof-requirements/route.ts` |
| GET | `/api/portal/v2/proof-shares/[token]` | `apps/api/app/api/portal/v2/proof-shares/[token]/route.ts` |
| POST | `/api/portal/v2/quotes/[partnerQuoteId]/decision` | `apps/api/app/api/portal/v2/quotes/[partnerQuoteId]/decision/route.ts` |
| GET | `/api/portal/v2/quotes/[partnerQuoteId]/document` | `apps/api/app/api/portal/v2/quotes/[partnerQuoteId]/document/route.ts` |
| GET | `/api/portal/v2/quotes/[partnerQuoteId]` | `apps/api/app/api/portal/v2/quotes/[partnerQuoteId]/route.ts` |
| GET | `/api/portal/v2/quotes` | `apps/api/app/api/portal/v2/quotes/route.ts` |
| GET, PATCH | `/api/portal/v2/recurring-series/[seriesId]` | `apps/api/app/api/portal/v2/recurring-series/[seriesId]/route.ts` |
| GET, POST | `/api/portal/v2/recurring-series` | `apps/api/app/api/portal/v2/recurring-series/route.ts` |
| GET | `/api/portal/v2/reports` | `apps/api/app/api/portal/v2/reports/route.ts` |
| POST | `/api/portal/v2/security/email-change/request` | `apps/api/app/api/portal/v2/security/email-change/request/route.ts` |
| POST | `/api/portal/v2/security/password` | `apps/api/app/api/portal/v2/security/password/route.ts` |
| GET | `/api/portal/v2/service-catalog` | `apps/api/app/api/portal/v2/service-catalog/route.ts` |
| POST | `/api/portal/v2/service-templates/[templateId]/apply` | `apps/api/app/api/portal/v2/service-templates/[templateId]/apply/route.ts` |
| PATCH | `/api/portal/v2/service-templates/[templateId]` | `apps/api/app/api/portal/v2/service-templates/[templateId]/route.ts` |
| GET, POST | `/api/portal/v2/service-templates` | `apps/api/app/api/portal/v2/service-templates/route.ts` |
| POST | `/api/portal/v2/session/account` | `apps/api/app/api/portal/v2/session/account/route.ts` |
| GET | `/api/portal/v2/session` | `apps/api/app/api/portal/v2/session/route.ts` |
| POST | `/api/portal/v2/sessions/[sessionHandle]/revoke` | `apps/api/app/api/portal/v2/sessions/[sessionHandle]/revoke/route.ts` |
| GET | `/api/portal/v2/sessions` | `apps/api/app/api/portal/v2/sessions/route.ts` |
| GET | `/api/portal/v2/statements` | `apps/api/app/api/portal/v2/statements/route.ts` |
| GET | `/api/portal/v2/threads` | `apps/api/app/api/portal/v2/threads/route.ts` |
| GET | `/api/public/blog/[slug]` | `apps/api/app/api/public/blog/[slug]/route.ts` |
| GET | `/api/public/blog` | `apps/api/app/api/public/blog/route.ts` |
| GET, HEAD, OPTIONS | `/api/public/inbox/uploads/[uploadId]` | `apps/api/app/api/public/inbox/uploads/[uploadId]/route.ts` |
| GET, HEAD, OPTIONS | `/api/public/junk-quote/uploads/[assetId]` | `apps/api/app/api/public/junk-quote/uploads/[assetId]/route.ts` |
| POST, OPTIONS | `/api/public/junk-quote/uploads` | `apps/api/app/api/public/junk-quote/uploads/route.ts` |
| POST, OPTIONS | `/api/public/openai/ads/consent` | `apps/api/app/api/public/openai/ads/consent/route.ts` |
| POST | `/api/public/partners/exchange` | `apps/api/app/api/public/partners/exchange/route.ts` |
| POST | `/api/public/partners/login-password` | `apps/api/app/api/public/partners/login-password/route.ts` |
| POST | `/api/public/partners/request-link` | `apps/api/app/api/public/partners/request-link/route.ts` |
| GET | `/api/public/quotes/[token]/attachments/[attachmentId]` | `apps/api/app/api/public/quotes/[token]/attachments/[attachmentId]/route.ts` |
| GET | `/api/public/quotes/[token]/availability` | `apps/api/app/api/public/quotes/[token]/availability/route.ts` |
| POST | `/api/public/quotes/[token]/book` | `apps/api/app/api/public/quotes/[token]/book/route.ts` |
| POST | `/api/public/quotes/[token]/changes` | `apps/api/app/api/public/quotes/[token]/changes/route.ts` |
| GET, POST | `/api/public/quotes/[token]/checkout` | `apps/api/app/api/public/quotes/[token]/checkout/route.ts` |
| POST | `/api/public/quotes/[token]/engagement` | `apps/api/app/api/public/quotes/[token]/engagement/route.ts` |
| POST | `/api/public/quotes/[token]/hold` | `apps/api/app/api/public/quotes/[token]/hold/route.ts` |
| GET | `/api/public/quotes/[token]/pdf` | `apps/api/app/api/public/quotes/[token]/pdf/route.ts` |
| POST | `/api/public/quotes/[token]/refresh` | `apps/api/app/api/public/quotes/[token]/refresh/route.ts` |
| GET, POST | `/api/public/quotes/[token]` | `apps/api/app/api/public/quotes/[token]/route.ts` |
| POST | `/api/public/team/exchange` | `apps/api/app/api/public/team/exchange/route.ts` |
| POST | `/api/public/team/login-password` | `apps/api/app/api/public/team/login-password/route.ts` |
| POST | `/api/public/team/request-link` | `apps/api/app/api/public/team/request-link/route.ts` |
| GET | `/api/public/team/session` | `apps/api/app/api/public/team/session/route.ts` |
| POST, OPTIONS | `/api/public/web-events` | `apps/api/app/api/public/web-events/route.ts` |
| GET | `/api/quote-versions/[id]/acceptance-certificate` | `apps/api/app/api/quote-versions/[id]/acceptance-certificate/route.ts` |
| GET | `/api/quote-versions/[id]/attachments/[attachmentId]/content` | `apps/api/app/api/quote-versions/[id]/attachments/[attachmentId]/content/route.ts` |
| DELETE | `/api/quote-versions/[id]/attachments/[attachmentId]` | `apps/api/app/api/quote-versions/[id]/attachments/[attachmentId]/route.ts` |
| GET, POST | `/api/quote-versions/[id]/attachments` | `apps/api/app/api/quote-versions/[id]/attachments/route.ts` |
| POST | `/api/quote-versions/[id]/issue` | `apps/api/app/api/quote-versions/[id]/issue/route.ts` |
| GET | `/api/quote-versions/[id]/preview` | `apps/api/app/api/quote-versions/[id]/preview/route.ts` |
| POST | `/api/quote-versions/[id]/send-attempts` | `apps/api/app/api/quote-versions/[id]/send-attempts/route.ts` |
| POST | `/api/quotes/[id]/archive` | `apps/api/app/api/quotes/[id]/archive/route.ts` |
| POST | `/api/quotes/[id]/capabilities/[capabilityId]/replace` | `apps/api/app/api/quotes/[id]/capabilities/[capabilityId]/replace/route.ts` |
| POST | `/api/quotes/[id]/capabilities/[capabilityId]/revoke` | `apps/api/app/api/quotes/[id]/capabilities/[capabilityId]/revoke/route.ts` |
| POST | `/api/quotes/[id]/change-requests/[requestId]/resolve` | `apps/api/app/api/quotes/[id]/change-requests/[requestId]/resolve/route.ts` |
| POST | `/api/quotes/[id]/decision` | `apps/api/app/api/quotes/[id]/decision/route.ts` |
| POST | `/api/quotes/[id]/decisions` | `apps/api/app/api/quotes/[id]/decisions/route.ts` |
| PATCH | `/api/quotes/[id]/draft` | `apps/api/app/api/quotes/[id]/draft/route.ts` |
| POST | `/api/quotes/[id]/finalize` | `apps/api/app/api/quotes/[id]/finalize/route.ts` |
| POST | `/api/quotes/[id]/revisions` | `apps/api/app/api/quotes/[id]/revisions/route.ts` |
| GET, PATCH, DELETE | `/api/quotes/[id]` | `apps/api/app/api/quotes/[id]/route.ts` |
| POST | `/api/quotes/[id]/send` | `apps/api/app/api/quotes/[id]/send/route.ts` |
| POST | `/api/quotes/[id]/void` | `apps/api/app/api/quotes/[id]/void/route.ts` |
| GET, POST | `/api/quotes` | `apps/api/app/api/quotes/route.ts` |
| GET | `/api/readyz` | `apps/api/app/api/readyz/route.ts` |
| GET | `/api/revenue/summary` | `apps/api/app/api/revenue/summary/route.ts` |
| POST | `/api/team/logout` | `apps/api/app/api/team/logout/route.ts` |
| POST | `/api/team/password` | `apps/api/app/api/team/password/route.ts` |
| POST | `/api/web/appointments/[id]/reschedule` | `apps/api/app/api/web/appointments/[id]/reschedule/route.ts` |
| POST, OPTIONS | `/api/web/lead-intake` | `apps/api/app/api/web/lead-intake/route.ts` |
| POST | `/api/web/quote-request` | `apps/api/app/api/web/quote-request/route.ts` |
| POST | `/api/webhooks/dm` | `apps/api/app/api/webhooks/dm/route.ts` |
| POST | `/api/webhooks/email` | `apps/api/app/api/webhooks/email/route.ts` |
| GET, POST | `/api/webhooks/facebook` | `apps/api/app/api/webhooks/facebook/route.ts` |
| POST | `/api/webhooks/square` | `apps/api/app/api/webhooks/square/route.ts` |
| POST | `/api/webhooks/twilio/call-status` | `apps/api/app/api/webhooks/twilio/call-status/route.ts` |
| GET, POST | `/api/webhooks/twilio/connect` | `apps/api/app/api/webhooks/twilio/connect/route.ts` |
| POST | `/api/webhooks/twilio/dial-action` | `apps/api/app/api/webhooks/twilio/dial-action/route.ts` |
| GET, POST | `/api/webhooks/twilio/escalate` | `apps/api/app/api/webhooks/twilio/escalate/route.ts` |
| GET, POST | `/api/webhooks/twilio/notice` | `apps/api/app/api/webhooks/twilio/notice/route.ts` |
| POST | `/api/webhooks/twilio/sms` | `apps/api/app/api/webhooks/twilio/sms/route.ts` |
| POST | `/api/webhooks/twilio/voice` | `apps/api/app/api/webhooks/twilio/voice/route.ts` |
