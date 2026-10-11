# API Route Index (apps/site)

Generated from source. Fingerprint: `90424e42126ed446`.

Routes discovered: 126

This index inventories exported HTTP handlers. It does not replace endpoint authentication, request-schema, response-schema, or side-effect documentation.

| Method(s) | Path | Handler |
| --- | --- | --- |
| GET | `/api/admin/appointments` | `apps/site/src/app/api/admin/appointments/route.ts` |
| POST | `/api/admin/session` | `apps/site/src/app/api/admin/session/route.ts` |
| POST | `/api/chat/action-approvals` | `apps/site/src/app/api/chat/action-approvals/route.ts` |
| POST | `/api/chat/actions` | `apps/site/src/app/api/chat/actions/route.ts` |
| POST | `/api/chat/book` | `apps/site/src/app/api/chat/book/route.ts` |
| POST | `/api/chat` | `apps/site/src/app/api/chat/route.ts` |
| POST | `/api/chat/stt` | `apps/site/src/app/api/chat/stt/route.ts` |
| POST | `/api/chat/tts` | `apps/site/src/app/api/chat/tts/route.ts` |
| GET | `/api/healthz` | `apps/site/src/app/api/healthz/route.ts` |
| POST | `/api/mobile/appointment-media/[mediaId]/complete` | `apps/site/src/app/api/mobile/appointment-media/[mediaId]/complete/route.ts` |
| POST | `/api/mobile/appointment-media/[mediaId]/restore` | `apps/site/src/app/api/mobile/appointment-media/[mediaId]/restore/route.ts` |
| PATCH, DELETE | `/api/mobile/appointment-media/[mediaId]` | `apps/site/src/app/api/mobile/appointment-media/[mediaId]/route.ts` |
| PUT | `/api/mobile/appointment-media/[mediaId]/upload` | `apps/site/src/app/api/mobile/appointment-media/[mediaId]/upload/route.ts` |
| PUT | `/api/mobile/appointments/[appointmentId]/final-total` | `apps/site/src/app/api/mobile/appointments/[appointmentId]/final-total/route.ts` |
| POST | `/api/mobile/appointments/[appointmentId]/manual-payments` | `apps/site/src/app/api/mobile/appointments/[appointmentId]/manual-payments/route.ts` |
| GET | `/api/mobile/appointments/[appointmentId]/media/manage-options` | `apps/site/src/app/api/mobile/appointments/[appointmentId]/media/manage-options/route.ts` |
| GET | `/api/mobile/appointments/[appointmentId]/media` | `apps/site/src/app/api/mobile/appointments/[appointmentId]/media/route.ts` |
| POST | `/api/mobile/appointments/[appointmentId]/media/upload-intents` | `apps/site/src/app/api/mobile/appointments/[appointmentId]/media/upload-intents/route.ts` |
| POST | `/api/mobile/appointments/[appointmentId]/payment-attempts` | `apps/site/src/app/api/mobile/appointments/[appointmentId]/payment-attempts/route.ts` |
| GET | `/api/mobile/appointments/[appointmentId]/payments` | `apps/site/src/app/api/mobile/appointments/[appointmentId]/payments/route.ts` |
| PATCH | `/api/mobile/appointments/[appointmentId]/quoted-scope` | `apps/site/src/app/api/mobile/appointments/[appointmentId]/quoted-scope/route.ts` |
| POST | `/api/mobile/expenses/[expenseId]/correct` | `apps/site/src/app/api/mobile/expenses/[expenseId]/correct/route.ts` |
| GET | `/api/mobile/expenses/[expenseId]/receipt` | `apps/site/src/app/api/mobile/expenses/[expenseId]/receipt/route.ts` |
| GET | `/api/mobile/expenses/capabilities` | `apps/site/src/app/api/mobile/expenses/capabilities/route.ts` |
| POST | `/api/mobile/expenses/captures/[captureId]/confirm` | `apps/site/src/app/api/mobile/expenses/captures/[captureId]/confirm/route.ts` |
| GET | `/api/mobile/expenses/captures/[captureId]/content` | `apps/site/src/app/api/mobile/expenses/captures/[captureId]/content/route.ts` |
| POST | `/api/mobile/expenses/captures/[captureId]/finalize` | `apps/site/src/app/api/mobile/expenses/captures/[captureId]/finalize/route.ts` |
| GET, DELETE | `/api/mobile/expenses/captures/[captureId]` | `apps/site/src/app/api/mobile/expenses/captures/[captureId]/route.ts` |
| PUT | `/api/mobile/expenses/captures/[captureId]/upload` | `apps/site/src/app/api/mobile/expenses/captures/[captureId]/upload/route.ts` |
| GET, POST | `/api/mobile/expenses/captures` | `apps/site/src/app/api/mobile/expenses/captures/route.ts` |
| GET | `/api/mobile/expenses/categories` | `apps/site/src/app/api/mobile/expenses/categories/route.ts` |
| GET, POST, PUT | `/api/mobile/expenses/daily-ad-spend` | `apps/site/src/app/api/mobile/expenses/daily-ad-spend/route.ts` |
| PATCH | `/api/mobile/expenses/fixed-costs/[seriesId]` | `apps/site/src/app/api/mobile/expenses/fixed-costs/[seriesId]/route.ts` |
| GET, POST | `/api/mobile/expenses/fixed-costs` | `apps/site/src/app/api/mobile/expenses/fixed-costs/route.ts` |
| GET | `/api/mobile/expenses/overview` | `apps/site/src/app/api/mobile/expenses/overview/route.ts` |
| POST | `/api/mobile/expenses/queue-health` | `apps/site/src/app/api/mobile/expenses/queue-health/route.ts` |
| POST | `/api/mobile/expenses/submissions/[expenseId]/review` | `apps/site/src/app/api/mobile/expenses/submissions/[expenseId]/review/route.ts` |
| GET, POST | `/api/mobile/expenses/submissions` | `apps/site/src/app/api/mobile/expenses/submissions/route.ts` |
| POST | `/api/mobile/inbox/threads/[threadId]/messages` | `apps/site/src/app/api/mobile/inbox/threads/[threadId]/messages/route.ts` |
| GET | `/api/mobile/inbox/threads/[threadId]` | `apps/site/src/app/api/mobile/inbox/threads/[threadId]/route.ts` |
| GET | `/api/mobile/me` | `apps/site/src/app/api/mobile/me/route.ts` |
| POST | `/api/mobile/offline-media-queue-health` | `apps/site/src/app/api/mobile/offline-media-queue-health/route.ts` |
| POST | `/api/mobile/owner/payout-runs/refresh` | `apps/site/src/app/api/mobile/owner/payout-runs/refresh/route.ts` |
| GET | `/api/mobile/owner/summary` | `apps/site/src/app/api/mobile/owner/summary/route.ts` |
| POST | `/api/owner-chat` | `apps/site/src/app/api/owner-chat/route.ts` |
| GET, POST, PATCH | `/api/partners/onboarding/[...segments]` | `apps/site/src/app/api/partners/onboarding/[...segments]/route.ts` |
| GET, POST, PUT, PATCH, DELETE | `/api/partners/portal/[...segments]` | `apps/site/src/app/api/partners/portal/[...segments]/route.ts` |
| GET, POST | `/api/public/quotes/[token]/[[...segments]]` | `apps/site/src/app/api/public/quotes/[token]/[[...segments]]/route.ts` |
| GET | `/api/readyz` | `apps/site/src/app/api/readyz/route.ts` |
| POST | `/api/team/access/members/[memberId]/delete` | `apps/site/src/app/api/team/access/members/[memberId]/delete/route.ts` |
| POST | `/api/team/access/members/[memberId]` | `apps/site/src/app/api/team/access/members/[memberId]/route.ts` |
| POST | `/api/team/access/members` | `apps/site/src/app/api/team/access/members/route.ts` |
| POST | `/api/team/access/roles/[roleId]` | `apps/site/src/app/api/team/access/roles/[roleId]/route.ts` |
| POST | `/api/team/access/roles` | `apps/site/src/app/api/team/access/roles/route.ts` |
| POST | `/api/team/access/sales-settings` | `apps/site/src/app/api/team/access/sales-settings/route.ts` |
| POST | `/api/team/access/sessions/revoke` | `apps/site/src/app/api/team/access/sessions/revoke/route.ts` |
| POST | `/api/team/agent` | `apps/site/src/app/api/team/agent/route.ts` |
| POST | `/api/team/appointments/notes` | `apps/site/src/app/api/team/appointments/notes/route.ts` |
| POST | `/api/team/appointments/reschedule` | `apps/site/src/app/api/team/appointments/reschedule/route.ts` |
| POST | `/api/team/appointments/status` | `apps/site/src/app/api/team/appointments/status/route.ts` |
| GET | `/api/team/audit/export` | `apps/site/src/app/api/team/audit/export/route.ts` |
| GET | `/api/team/automation/lead` | `apps/site/src/app/api/team/automation/lead/route.ts` |
| DELETE | `/api/team/calls/coaching/[callRecordId]` | `apps/site/src/app/api/team/calls/coaching/[callRecordId]/route.ts` |
| GET | `/api/team/calls/operations/[operationId]` | `apps/site/src/app/api/team/calls/operations/[operationId]/route.ts` |
| POST | `/api/team/calls/start` | `apps/site/src/app/api/team/calls/start/route.ts` |
| POST | `/api/team/commissions/crew-pool-overrides` | `apps/site/src/app/api/team/commissions/crew-pool-overrides/route.ts` |
| GET | `/api/team/commissions/payout-runs/[payoutRunId]/export` | `apps/site/src/app/api/team/commissions/payout-runs/[payoutRunId]/export/route.ts` |
| POST | `/api/team/commissions/payout-runs/[payoutRunId]/reimbursements` | `apps/site/src/app/api/team/commissions/payout-runs/[payoutRunId]/reimbursements/route.ts` |
| GET | `/api/team/commissions/payout-runs/[payoutRunId]/report` | `apps/site/src/app/api/team/commissions/payout-runs/[payoutRunId]/report/route.ts` |
| POST | `/api/team/commissions/payout-runs` | `apps/site/src/app/api/team/commissions/payout-runs/route.ts` |
| POST | `/api/team/commissions/settings` | `apps/site/src/app/api/team/commissions/settings/route.ts` |
| POST | `/api/team/contacts/assignee` | `apps/site/src/app/api/team/contacts/assignee/route.ts` |
| POST | `/api/team/contacts/contact` | `apps/site/src/app/api/team/contacts/contact/route.ts` |
| GET, POST | `/api/team/contacts/media-analysis` | `apps/site/src/app/api/team/contacts/media-analysis/route.ts` |
| POST | `/api/team/contacts/name` | `apps/site/src/app/api/team/contacts/name/route.ts` |
| POST, PATCH | `/api/team/contacts/notes/[noteId]` | `apps/site/src/app/api/team/contacts/notes/[noteId]/route.ts` |
| POST | `/api/team/contacts/notes` | `apps/site/src/app/api/team/contacts/notes/route.ts` |
| POST | `/api/team/contacts/pipeline` | `apps/site/src/app/api/team/contacts/pipeline/route.ts` |
| GET | `/api/team/contacts/quote-photos` | `apps/site/src/app/api/team/contacts/quote-photos/route.ts` |
| POST, PATCH | `/api/team/contacts/reminders/[taskId]` | `apps/site/src/app/api/team/contacts/reminders/[taskId]/route.ts` |
| POST | `/api/team/contacts/reminders` | `apps/site/src/app/api/team/contacts/reminders/route.ts` |
| GET, POST | `/api/team/contacts` | `apps/site/src/app/api/team/contacts/route.ts` |
| GET, POST | `/api/team/contacts/sales-agent-memory` | `apps/site/src/app/api/team/contacts/sales-agent-memory/route.ts` |
| GET, POST, PATCH | `/api/team/contacts/sales-agent-next-action` | `apps/site/src/app/api/team/contacts/sales-agent-next-action/route.ts` |
| GET | `/api/team/contacts/summary` | `apps/site/src/app/api/team/contacts/summary/route.ts` |
| GET | `/api/team/contacts/workspace` | `apps/site/src/app/api/team/contacts/workspace/route.ts` |
| POST | `/api/team/expenses/[expenseId]/correct` | `apps/site/src/app/api/team/expenses/[expenseId]/correct/route.ts` |
| POST | `/api/team/expenses/[expenseId]/post` | `apps/site/src/app/api/team/expenses/[expenseId]/post/route.ts` |
| GET | `/api/team/expenses/[expenseId]/receipt` | `apps/site/src/app/api/team/expenses/[expenseId]/receipt/route.ts` |
| POST | `/api/team/expenses/[expenseId]` | `apps/site/src/app/api/team/expenses/[expenseId]/route.ts` |
| POST | `/api/team/expenses/[expenseId]/void` | `apps/site/src/app/api/team/expenses/[expenseId]/void/route.ts` |
| GET | `/api/team/expenses/export` | `apps/site/src/app/api/team/expenses/export/route.ts` |
| POST | `/api/team/expenses` | `apps/site/src/app/api/team/expenses/route.ts` |
| GET, POST | `/api/team/flash/clear` | `apps/site/src/app/api/team/flash/clear/route.ts` |
| POST | `/api/team/inbox/export` | `apps/site/src/app/api/team/inbox/export/route.ts` |
| GET, HEAD | `/api/team/inbox/media/[messageId]/[index]` | `apps/site/src/app/api/team/inbox/media/[messageId]/[index]/route.ts` |
| GET | `/api/team/inbox/threads/[threadId]` | `apps/site/src/app/api/team/inbox/threads/[threadId]/route.ts` |
| POST | `/api/team/inbox/threads/[threadId]/suggest` | `apps/site/src/app/api/team/inbox/threads/[threadId]/suggest/route.ts` |
| GET | `/api/team/inbox/threads` | `apps/site/src/app/api/team/inbox/threads/route.ts` |
| GET | `/api/team/inbox/timeline` | `apps/site/src/app/api/team/inbox/timeline/route.ts` |
| POST | `/api/team/outbound/import` | `apps/site/src/app/api/team/outbound/import/route.ts` |
| DELETE | `/api/team/pipeline/presets/[presetId]` | `apps/site/src/app/api/team/pipeline/presets/[presetId]/route.ts` |
| POST | `/api/team/pipeline/presets` | `apps/site/src/app/api/team/pipeline/presets/route.ts` |
| POST | `/api/team/quotes/scope-draft` | `apps/site/src/app/api/team/quotes/scope-draft/route.ts` |
| GET, POST, PATCH, DELETE | `/api/team/quotes/v2/[...segments]` | `apps/site/src/app/api/team/quotes/v2/[...segments]/route.ts` |
| GET | `/api/team/sales/activity/export` | `apps/site/src/app/api/team/sales/activity/export/route.ts` |
| POST | `/api/team/sales/disposition` | `apps/site/src/app/api/team/sales/disposition/route.ts` |
| POST | `/api/team/sales/reset` | `apps/site/src/app/api/team/sales/reset/route.ts` |
| POST | `/api/team/sales/touch` | `apps/site/src/app/api/team/sales/touch/route.ts` |
| POST | `/api/team/settings/sessions/revoke` | `apps/site/src/app/api/team/settings/sessions/revoke/route.ts` |
| POST | `/api/team/simulated-chat` | `apps/site/src/app/api/team/simulated-chat/route.ts` |
| POST | `/api/team/stt` | `apps/site/src/app/api/team/stt/route.ts` |
| GET | `/mobile/auth` | `apps/site/src/app/mobile/auth/route.ts` |
| POST | `/mobile/login/magic-link` | `apps/site/src/app/mobile/login/magic-link/route.ts` |
| POST | `/mobile/login/password` | `apps/site/src/app/mobile/login/password/route.ts` |
| POST | `/mobile/password` | `apps/site/src/app/mobile/password/route.ts` |
| GET | `/mobile/payment-return` | `apps/site/src/app/mobile/payment-return/route.ts` |
| GET | `/partners/application/expired` | `apps/site/src/app/partners/application/expired/route.ts` |
| GET | `/partners/auth` | `apps/site/src/app/partners/auth/route.ts` |
| POST | `/partners/form` | `apps/site/src/app/partners/form/route.ts` |
| POST | `/partners/invitations/accept/complete` | `apps/site/src/app/partners/invitations/accept/complete/route.ts` |
| POST | `/partners/logout` | `apps/site/src/app/partners/logout/route.ts` |
| GET | `/partners/media/[jobId]/[evidenceId]` | `apps/site/src/app/partners/media/[jobId]/[evidenceId]/route.ts` |
| GET | `/partners/verify` | `apps/site/src/app/partners/verify/route.ts` |
| GET | `/quote/[token]/pdf` | `apps/site/src/app/quote/[token]/pdf/route.ts` |
| GET | `/team/auth` | `apps/site/src/app/team/auth/route.ts` |
