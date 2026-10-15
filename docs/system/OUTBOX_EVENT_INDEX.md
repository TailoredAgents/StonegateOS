# Outbox Event Index

Generated from production TypeScript sources. Fingerprint: `10ae35c27306d493`.

Literal event types discovered: 80

Outbox events are durable asynchronous jobs stored in `outbox_events`. This index reports literal queue sites and switch handlers; computed event names and delegated workers still require curated review.

| Type | Queued by (up to 3 examples) | Handler candidates |
| --- | --- | --- |
| `ads.openai.consent_revoked` | `apps/api/src/lib/openai-ads-consent.ts:48` | Not found by literal scan |
| `ads.openai.conversion` | `apps/api/src/lib/openai-ads-capture.ts:142` | `apps/api/src/lib/outbox-processor.ts:3760` |
| `appointment_media.attach_appointment` | `apps/api/src/lib/outbox-processor.ts:4859` | `apps/api/src/lib/outbox-processor.ts:4671` |
| `appointment_media.import_message` | `apps/api/src/lib/inbox.ts:1121` | `apps/api/src/lib/outbox-processor.ts:4644` |
| `appointment.calendar_sync_requested` | `apps/api/app/api/appointments/[id]/convert/route.ts:1095`<br>`apps/api/app/api/appointments/[id]/status/route.ts:1710`<br>`apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts:769` | `apps/api/src/lib/outbox-processor.ts:4641` |
| `call.recording.delete` | `apps/api/src/lib/call-recording-persistence.ts:371` | `apps/api/src/lib/outbox-processor.ts:7312` |
| `call.recording.process` | `apps/api/app/api/webhooks/twilio/call-status/route.ts:760`<br>`apps/api/src/lib/manual-call-callbacks.ts:121`<br>`apps/api/src/lib/sales-escalation-call-operations.ts:1316` | `apps/api/src/lib/outbox-processor.ts:6998` |
| `contact.alert` | `apps/api/src/lib/inbox.ts:462` | `apps/api/src/lib/outbox-processor.ts:5715` |
| `crm.reminder.sms` | `apps/api/app/api/admin/crm/reminders/[taskId]/route.ts:371`<br>`apps/api/app/api/admin/crm/reminders/route.ts:335`<br>`apps/api/app/api/admin/outbound/bulk/route.ts:118` | `apps/api/src/lib/outbox-processor.ts:6240` |
| `estimate.reminder` | `apps/api/src/lib/notifications.ts:645`<br>`apps/api/src/lib/outbox-processor.ts:3369` | `apps/api/src/lib/outbox-processor.ts:6759` |
| `estimate.requested` | `apps/api/app/api/admin/booking/book/route.ts:761`<br>`apps/api/src/lib/quote-scheduling.ts:1151` | `apps/api/src/lib/outbox-processor.ts:4833` |
| `estimate.rescheduled` | `apps/api/app/api/web/appointments/[id]/reschedule/route.ts:423` | `apps/api/src/lib/outbox-processor.ts:5015` |
| `estimate.status_changed` | `apps/api/app/api/appointments/[id]/convert/route.ts:1073`<br>`apps/api/app/api/appointments/[id]/status/route.ts:1688`<br>`apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts:758` | `apps/api/src/lib/outbox-processor.ts:5183` |
| `expense.receipt.analyze` | `apps/api/src/lib/expense-receipt-captures.ts:686` | `apps/api/src/lib/outbox-processor.ts:4082` |
| `facebook.dm.inbound` | `apps/api/app/api/webhooks/facebook/route.ts:184` | `apps/api/src/lib/outbox-processor.ts:4698` |
| `facebook.dm.postback` | `apps/api/app/api/webhooks/facebook/route.ts:210` | `apps/api/src/lib/outbox-processor.ts:4747` |
| `facebook.leadgen.created` | `apps/api/app/api/webhooks/facebook/route.ts:247` | `apps/api/src/lib/outbox-processor.ts:4802` |
| `facebook.sales.action.execute` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:7452` |
| `facebook.sales.action.proposed` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:7451` |
| `facebook.sales.evaluate` | `apps/api/src/lib/outbox-processor.ts:7428` | `apps/api/src/lib/outbox-processor.ts:7435` |
| `facebook.sales.human_review` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:7453` |
| `facebook.sales.shadow_decision` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:7454` |
| `followup.schedule` | `apps/api/app/api/brush-quote/route.ts:833`<br>`apps/api/app/api/demo-quote/route.ts:685`<br>`apps/api/app/api/junk-quote/route.ts:1238` | `apps/api/src/lib/outbox-processor.ts:6804` |
| `followup.send` | `apps/api/src/lib/outbox-processor.ts:3297` | `apps/api/src/lib/outbox-processor.ts:6824` |
| `google.ads_analyst.run` | `apps/api/app/api/admin/google/ads/analyst/run/route.ts:42`<br>`apps/api/src/lib/google-ads-analyst-scheduler.ts:63` | `apps/api/src/lib/outbox-processor.ts:6709` |
| `google.ads_insights.sync` | `apps/api/app/api/admin/google/ads/sync/route.ts:60`<br>`apps/api/src/lib/google-ads-scheduler.ts:43` | `apps/api/src/lib/outbox-processor.ts:6632` |
| `lead.alert` | `apps/api/app/api/brush-quote/route.ts:793`<br>`apps/api/app/api/demo-quote/route.ts:645`<br>`apps/api/app/api/junk-quote/book/route.ts:563` | `apps/api/src/lib/outbox-processor.ts:5586` |
| `lead.created` | `apps/api/src/lib/facebook-webhooks.ts:809` | `apps/api/src/lib/outbox-processor.ts:5184` |
| `message.received` | `apps/api/src/lib/inbox.ts:1106` | `apps/api/src/lib/outbox-processor.ts:7387` |
| `message.send` | `apps/api/app/api/admin/inbox/messages/[messageId]/retry/route.ts:249`<br>`apps/api/app/api/admin/inbox/messages/[messageId]/retry/route.ts:288`<br>`apps/api/app/api/admin/inbox/threads/[threadId]/messages/route.ts:577` | `apps/api/src/lib/outbox-processor.ts:7496` |
| `meta.ads_insights.sync` | `apps/api/app/api/admin/meta/ads/sync/route.ts:60` | `apps/api/src/lib/outbox-processor.ts:6566` |
| `meta.lead_event` | `apps/api/src/lib/facebook-webhooks.ts:820` | `apps/api/src/lib/outbox-processor.ts:6409` |
| `partner.access_application.email` | `apps/api/src/lib/partner-access-application-email-delivery.ts:162` | `apps/api/src/lib/outbox-processor.ts:3976` |
| `partner.account_invitation.email` | `apps/api/src/lib/partner-account-invitations.ts:1087`<br>`apps/api/src/lib/partner-account-invitations.ts:770` | `apps/api/src/lib/outbox-processor.ts:3896` |
| `partner.approval.decided` | `apps/api/src/lib/partner-portal-v2-approvals.ts:2595` | `apps/api/src/lib/outbox-processor.ts:3892` |
| `partner.approval.requested` | `apps/api/src/lib/partner-multi-service.ts:549`<br>`apps/api/src/lib/partner-portal-v2-scheduling/service.ts:4481`<br>`apps/api/src/lib/partner-portal-v2-scheduling/service.ts:4942` | `apps/api/src/lib/outbox-processor.ts:3891` |
| `partner.auth.email` | `apps/api/src/lib/partner-purpose-auth.ts:272` | `apps/api/src/lib/outbox-processor.ts:3930` |
| `partner.billing_dispute.requested` | `apps/api/src/lib/partner-billing-dispute-requests.ts:773` | `apps/api/src/lib/outbox-processor.ts:4167` |
| `partner.billing_dispute.resolved` | `apps/api/src/lib/partner-billing-dispute-requests.ts:1051` | `apps/api/src/lib/outbox-processor.ts:4237` |
| `partner.billing.document.generate` | `apps/api/src/lib/partner-billing-documents.ts:114` | `apps/api/src/lib/outbox-processor.ts:3867` |
| `partner.billing.refund.submit` | `apps/api/src/lib/partner-billing-administration.ts:959` | `apps/api/src/lib/outbox-processor.ts:3776` |
| `partner.bulk_import.process` | `apps/api/src/lib/partner-repeat-work.ts:3635`<br>`apps/api/src/lib/partner-repeat-work.ts:3914`<br>`apps/api/src/lib/partner-repeat-work.ts:3976` | `apps/api/src/lib/outbox-processor.ts:3762` |
| `partner.cancellation_request.resolved` | `apps/api/src/lib/partner-cancellation-request-lifecycle.ts:531` | `apps/api/src/lib/outbox-processor.ts:4444` |
| `partner.cancellation_review_requested` | `apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts:556` | `apps/api/src/lib/outbox-processor.ts:4325` |
| `partner.document.scan` | `apps/api/src/lib/partner-portal-v2-media.ts:1600` | `apps/api/src/lib/outbox-processor.ts:3850` |
| `partner.invoice.credited` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3883` |
| `partner.invoice.issued` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3882` |
| `partner.job_change_order.resolved` | `apps/api/src/lib/partner-job-change-orders.ts:573`<br>`apps/api/src/lib/partner-job-change-orders.ts:674` | Not found by literal scan |
| `partner.job_change_request.requested` | `apps/api/src/lib/partner-job-change-request-lifecycle.ts:429` | `apps/api/src/lib/outbox-processor.ts:4492` |
| `partner.job_change_request.resolved` | `apps/api/src/lib/partner-job-change-request-lifecycle.ts:599`<br>`apps/api/src/lib/partner-job-change-request-lifecycle.ts:963` | `apps/api/src/lib/outbox-processor.ts:4538` |
| `partner.job_references.updated` | `apps/api/src/lib/partner-job-change-request-lifecycle.ts:1190` | `apps/api/src/lib/outbox-processor.ts:4593` |
| `partner.job.completed` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3889` |
| `partner.job.en_route` | `apps/api/src/lib/eta-agent.ts:656` | `apps/api/src/lib/outbox-processor.ts:3890` |
| `partner.job.status_committed` | `apps/api/src/lib/partner-job-lifecycle.ts:154`<br>`apps/api/src/lib/partner-multi-service.ts:1088`<br>`apps/api/src/lib/partner-multi-service.ts:1291` | `apps/api/src/lib/outbox-processor.ts:3788` |
| `partner.notification_endpoint.sms_code` | `apps/api/src/lib/partner-notification-endpoints.ts:579` | `apps/api/src/lib/outbox-processor.ts:4017` |
| `partner.notification.dispatch` | `apps/api/src/lib/partner-notification-delivery.ts:734` | `apps/api/src/lib/outbox-processor.ts:4060` |
| `partner.owner_alert.evaluate` | `apps/api/src/lib/partner-owner-alerts.ts:253` | `apps/api/src/lib/outbox-processor.ts:4097` |
| `partner.owner_alert.reminder` | `apps/api/src/lib/partner-owner-alerts.ts:578` | `apps/api/src/lib/outbox-processor.ts:4100` |
| `partner.payment.failed` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3886` |
| `partner.payment.processing` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3884` |
| `partner.payment.refunded` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3887` |
| `partner.payment.settled` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3885` |
| `partner.proof.prepare` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/packages/route.ts:153`<br>`apps/api/src/lib/partner-document-scan.ts:232`<br>`apps/api/src/lib/partner-job-lifecycle.ts:164` | `apps/api/src/lib/outbox-processor.ts:3833` |
| `partner.proof.ready` | `apps/api/src/lib/partner-completion-record.ts:439` | `apps/api/src/lib/outbox-processor.ts:3888` |
| `pipeline.auto_stage_change` | `apps/api/app/api/admin/booking/book/route.ts:793`<br>`apps/api/app/api/appointments/[id]/convert/route.ts:1036`<br>`apps/api/app/api/brush-quote/route.ts:818` | Not found by literal scan |
| `quote.accepted_and_booked.v2` | `apps/api/src/lib/quote-v2-scheduling-service.ts:1641`<br>`apps/api/src/lib/quote-v2-scheduling-service.ts:1646` | `apps/api/src/lib/outbox-processor.ts:5130`<br>`apps/api/src/lib/quote-v2-outbox-worker.ts:709` |
| `quote.change_requested` | `apps/api/app/api/public/quotes/[token]/changes/route.ts:368` | Not found by literal scan |
| `quote.change_requested.v2` | `apps/api/src/lib/quote-v2-public-service.ts:1128`<br>`apps/api/src/lib/quote-v2-public-service.ts:673`<br>`apps/api/src/lib/quote-v2-public-service.ts:907` | `apps/api/src/lib/outbox-processor.ts:5127`<br>`apps/api/src/lib/quote-v2-outbox-worker.ts:683` |
| `quote.decision` | `apps/api/app/api/public/quotes/[token]/route.ts:716`<br>`apps/api/src/lib/notifications.ts:888`<br>`apps/api/src/lib/notifications.ts:922` | `apps/api/src/lib/outbox-processor.ts:5133` |
| `quote.deposit_checkout_requested.v2` | `apps/api/src/lib/quote-v2-deposit-service.ts:349`<br>`apps/api/src/lib/quote-v2-deposit-service.ts:354` | `apps/api/src/lib/outbox-processor.ts:5129`<br>`apps/api/src/lib/quote-v2-outbox-worker.ts:700` |
| `quote.response_recorded.v2` | `apps/api/src/lib/quote-v2-terminal-decision.ts:101`<br>`apps/api/src/lib/quote-v2-terminal-decision.ts:104` | `apps/api/src/lib/outbox-processor.ts:5128`<br>`apps/api/src/lib/quote-v2-outbox-worker.ts:691` |
| `quote.send_requested.v2` | `apps/api/src/lib/quote-v2-issue-persistence.ts:473`<br>`apps/api/src/lib/quote-v2-issue-persistence.ts:478`<br>`apps/api/src/lib/quote-v2-send-attempt-service.ts:1183` | `apps/api/src/lib/outbox-processor.ts:5124` |
| `quote.sent` | `apps/api/app/api/quotes/[id]/send/route.ts:311`<br>`apps/api/src/lib/notifications.ts:745`<br>`apps/api/src/lib/notifications.ts:780` | `apps/api/src/lib/outbox-processor.ts:5083` |
| `review.request` | `apps/api/app/api/appointments/[id]/status/route.ts:1728` | `apps/api/src/lib/outbox-processor.ts:5422` |
| `sales.autopilot.autosend` | `apps/api/src/lib/outbox-processor.ts:3190`<br>`apps/api/src/lib/sales-autopilot.ts:1155` | `apps/api/src/lib/outbox-processor.ts:7473` |
| `sales.autopilot.draft` | `apps/api/src/lib/outbox-processor.ts:7417` | `apps/api/src/lib/outbox-processor.ts:7457` |
| `sales.escalation.call` | `apps/api/src/lib/outbox-processor.ts:1683`<br>`apps/api/src/lib/outbox-processor.ts:1940`<br>`apps/api/src/lib/sales-escalation-call-operations.ts:1962` | `apps/api/src/lib/outbox-processor.ts:5748` |
| `sales.queue.nudge.sms` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:6100` |
| `seed.initialized` | `scripts/seed-e2e.ts:336` | Not found by literal scan |
| `staff_notification.dispatch` | `apps/api/src/lib/partner-owner-alerts.ts:386`<br>`apps/api/src/lib/staff-notification-operations.ts:183` | `apps/api/src/lib/outbox-processor.ts:4103` |
