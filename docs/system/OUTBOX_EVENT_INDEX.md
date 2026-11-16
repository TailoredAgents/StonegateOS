# Outbox Event Index

Generated from production TypeScript sources. Fingerprint: `44b874499326a582`.

Literal event types discovered: 80

Outbox events are durable asynchronous jobs stored in `outbox_events`. This index reports literal queue sites and switch handlers; computed event names and delegated workers still require curated review.

| Type | Queued by (up to 3 examples) | Handler candidates |
| --- | --- | --- |
| `ads.openai.consent_revoked` | `apps/api/src/lib/openai-ads-consent.ts:48` | Not found by literal scan |
| `ads.openai.conversion` | `apps/api/src/lib/openai-ads-capture.ts:142` | `apps/api/src/lib/outbox-processor.ts:3763` |
| `appointment_media.attach_appointment` | `apps/api/src/lib/outbox-processor.ts:4862` | `apps/api/src/lib/outbox-processor.ts:4674` |
| `appointment_media.import_message` | `apps/api/src/lib/inbox.ts:1136` | `apps/api/src/lib/outbox-processor.ts:4647` |
| `appointment.calendar_sync_requested` | `apps/api/app/api/appointments/[id]/convert/route.ts:1095`<br>`apps/api/app/api/appointments/[id]/status/route.ts:1710`<br>`apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts:769` | `apps/api/src/lib/outbox-processor.ts:4644` |
| `call.recording.delete` | `apps/api/src/lib/call-recording-persistence.ts:371` | `apps/api/src/lib/outbox-processor.ts:7315` |
| `call.recording.process` | `apps/api/app/api/webhooks/twilio/call-status/route.ts:760`<br>`apps/api/src/lib/manual-call-callbacks.ts:121`<br>`apps/api/src/lib/sales-escalation-call-operations.ts:1316` | `apps/api/src/lib/outbox-processor.ts:7001` |
| `contact.alert` | `apps/api/src/lib/inbox.ts:463` | `apps/api/src/lib/outbox-processor.ts:5718` |
| `crm.reminder.sms` | `apps/api/app/api/admin/crm/reminders/[taskId]/route.ts:371`<br>`apps/api/app/api/admin/crm/reminders/route.ts:335`<br>`apps/api/app/api/admin/outbound/bulk/route.ts:118` | `apps/api/src/lib/outbox-processor.ts:6243` |
| `estimate.reminder` | `apps/api/src/lib/notifications.ts:645`<br>`apps/api/src/lib/outbox-processor.ts:3372` | `apps/api/src/lib/outbox-processor.ts:6762` |
| `estimate.requested` | `apps/api/app/api/admin/booking/book/route.ts:784`<br>`apps/api/src/lib/quote-scheduling.ts:1151` | `apps/api/src/lib/outbox-processor.ts:4836` |
| `estimate.rescheduled` | `apps/api/app/api/web/appointments/[id]/reschedule/route.ts:423` | `apps/api/src/lib/outbox-processor.ts:5018` |
| `estimate.status_changed` | `apps/api/app/api/appointments/[id]/convert/route.ts:1073`<br>`apps/api/app/api/appointments/[id]/status/route.ts:1688`<br>`apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts:758` | `apps/api/src/lib/outbox-processor.ts:5186` |
| `expense.receipt.analyze` | `apps/api/src/lib/expense-receipt-captures.ts:686` | `apps/api/src/lib/outbox-processor.ts:4085` |
| `facebook.dm.inbound` | `apps/api/app/api/webhooks/facebook/route.ts:184` | `apps/api/src/lib/outbox-processor.ts:4701` |
| `facebook.dm.postback` | `apps/api/app/api/webhooks/facebook/route.ts:210` | `apps/api/src/lib/outbox-processor.ts:4750` |
| `facebook.leadgen.created` | `apps/api/app/api/webhooks/facebook/route.ts:247` | `apps/api/src/lib/outbox-processor.ts:4805` |
| `facebook.sales.action.execute` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:7457` |
| `facebook.sales.action.proposed` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:7456` |
| `facebook.sales.evaluate` | `apps/api/src/lib/outbox-processor.ts:7433` | `apps/api/src/lib/outbox-processor.ts:7440` |
| `facebook.sales.human_review` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:7458` |
| `facebook.sales.shadow_decision` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:7459` |
| `followup.schedule` | `apps/api/app/api/brush-quote/route.ts:833`<br>`apps/api/app/api/demo-quote/route.ts:689`<br>`apps/api/app/api/junk-quote/route.ts:1241` | `apps/api/src/lib/outbox-processor.ts:6807` |
| `followup.send` | `apps/api/src/lib/outbox-processor.ts:3300` | `apps/api/src/lib/outbox-processor.ts:6827` |
| `google.ads_analyst.run` | `apps/api/app/api/admin/google/ads/analyst/run/route.ts:42`<br>`apps/api/src/lib/google-ads-analyst-scheduler.ts:63` | `apps/api/src/lib/outbox-processor.ts:6712` |
| `google.ads_insights.sync` | `apps/api/app/api/admin/google/ads/sync/route.ts:60`<br>`apps/api/src/lib/google-ads-scheduler.ts:43` | `apps/api/src/lib/outbox-processor.ts:6635` |
| `lead.alert` | `apps/api/app/api/brush-quote/route.ts:793`<br>`apps/api/app/api/demo-quote/route.ts:649`<br>`apps/api/app/api/junk-quote/book/route.ts:582` | `apps/api/src/lib/outbox-processor.ts:5589` |
| `lead.created` | `apps/api/src/lib/facebook-webhooks.ts:809` | `apps/api/src/lib/outbox-processor.ts:5187` |
| `message.received` | `apps/api/src/lib/inbox.ts:1121` | `apps/api/src/lib/outbox-processor.ts:7390` |
| `message.send` | `apps/api/app/api/admin/inbox/messages/[messageId]/retry/route.ts:249`<br>`apps/api/app/api/admin/inbox/messages/[messageId]/retry/route.ts:288`<br>`apps/api/app/api/admin/inbox/threads/[threadId]/messages/route.ts:577` | `apps/api/src/lib/outbox-processor.ts:7501` |
| `meta.ads_insights.sync` | `apps/api/app/api/admin/meta/ads/sync/route.ts:60` | `apps/api/src/lib/outbox-processor.ts:6569` |
| `meta.lead_event` | `apps/api/src/lib/facebook-webhooks.ts:820` | `apps/api/src/lib/outbox-processor.ts:6412` |
| `partner.access_application.email` | `apps/api/src/lib/partner-access-application-email-delivery.ts:162` | `apps/api/src/lib/outbox-processor.ts:3979` |
| `partner.account_invitation.email` | `apps/api/src/lib/partner-account-invitations.ts:1087`<br>`apps/api/src/lib/partner-account-invitations.ts:770` | `apps/api/src/lib/outbox-processor.ts:3899` |
| `partner.approval.decided` | `apps/api/src/lib/partner-portal-v2-approvals.ts:2595` | `apps/api/src/lib/outbox-processor.ts:3895` |
| `partner.approval.requested` | `apps/api/src/lib/partner-multi-service.ts:549`<br>`apps/api/src/lib/partner-portal-v2-scheduling/service.ts:4481`<br>`apps/api/src/lib/partner-portal-v2-scheduling/service.ts:4942` | `apps/api/src/lib/outbox-processor.ts:3894` |
| `partner.auth.email` | `apps/api/src/lib/partner-purpose-auth.ts:272` | `apps/api/src/lib/outbox-processor.ts:3933` |
| `partner.billing_dispute.requested` | `apps/api/src/lib/partner-billing-dispute-requests.ts:773` | `apps/api/src/lib/outbox-processor.ts:4170` |
| `partner.billing_dispute.resolved` | `apps/api/src/lib/partner-billing-dispute-requests.ts:1051` | `apps/api/src/lib/outbox-processor.ts:4240` |
| `partner.billing.document.generate` | `apps/api/src/lib/partner-billing-documents.ts:114` | `apps/api/src/lib/outbox-processor.ts:3870` |
| `partner.billing.refund.submit` | `apps/api/src/lib/partner-billing-administration.ts:959` | `apps/api/src/lib/outbox-processor.ts:3779` |
| `partner.bulk_import.process` | `apps/api/src/lib/partner-repeat-work.ts:3635`<br>`apps/api/src/lib/partner-repeat-work.ts:3914`<br>`apps/api/src/lib/partner-repeat-work.ts:3976` | `apps/api/src/lib/outbox-processor.ts:3765` |
| `partner.cancellation_request.resolved` | `apps/api/src/lib/partner-cancellation-request-lifecycle.ts:531` | `apps/api/src/lib/outbox-processor.ts:4447` |
| `partner.cancellation_review_requested` | `apps/api/app/api/portal/v2/jobs/[jobId]/cancel/route.ts:556` | `apps/api/src/lib/outbox-processor.ts:4328` |
| `partner.document.scan` | `apps/api/src/lib/partner-portal-v2-media.ts:1600` | `apps/api/src/lib/outbox-processor.ts:3853` |
| `partner.invoice.credited` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3886` |
| `partner.invoice.issued` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3885` |
| `partner.job_change_order.resolved` | `apps/api/src/lib/partner-job-change-orders.ts:573`<br>`apps/api/src/lib/partner-job-change-orders.ts:674` | Not found by literal scan |
| `partner.job_change_request.requested` | `apps/api/src/lib/partner-job-change-request-lifecycle.ts:429` | `apps/api/src/lib/outbox-processor.ts:4495` |
| `partner.job_change_request.resolved` | `apps/api/src/lib/partner-job-change-request-lifecycle.ts:599`<br>`apps/api/src/lib/partner-job-change-request-lifecycle.ts:963` | `apps/api/src/lib/outbox-processor.ts:4541` |
| `partner.job_references.updated` | `apps/api/src/lib/partner-job-change-request-lifecycle.ts:1190` | `apps/api/src/lib/outbox-processor.ts:4596` |
| `partner.job.completed` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3892` |
| `partner.job.en_route` | `apps/api/src/lib/eta-agent.ts:656` | `apps/api/src/lib/outbox-processor.ts:3893` |
| `partner.job.status_committed` | `apps/api/src/lib/partner-job-lifecycle.ts:154`<br>`apps/api/src/lib/partner-multi-service.ts:1088`<br>`apps/api/src/lib/partner-multi-service.ts:1291` | `apps/api/src/lib/outbox-processor.ts:3791` |
| `partner.notification_endpoint.sms_code` | `apps/api/src/lib/partner-notification-endpoints.ts:579` | `apps/api/src/lib/outbox-processor.ts:4020` |
| `partner.notification.dispatch` | `apps/api/src/lib/partner-notification-delivery.ts:734` | `apps/api/src/lib/outbox-processor.ts:4063` |
| `partner.owner_alert.evaluate` | `apps/api/src/lib/partner-owner-alerts.ts:253` | `apps/api/src/lib/outbox-processor.ts:4100` |
| `partner.owner_alert.reminder` | `apps/api/src/lib/partner-owner-alerts.ts:578` | `apps/api/src/lib/outbox-processor.ts:4103` |
| `partner.payment.failed` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3889` |
| `partner.payment.processing` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3887` |
| `partner.payment.refunded` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3890` |
| `partner.payment.settled` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:3888` |
| `partner.proof.prepare` | `apps/api/app/api/portal/v2/jobs/[jobId]/proof/packages/route.ts:153`<br>`apps/api/src/lib/partner-document-scan.ts:232`<br>`apps/api/src/lib/partner-job-lifecycle.ts:164` | `apps/api/src/lib/outbox-processor.ts:3836` |
| `partner.proof.ready` | `apps/api/src/lib/partner-completion-record.ts:439` | `apps/api/src/lib/outbox-processor.ts:3891` |
| `pipeline.auto_stage_change` | `apps/api/app/api/admin/booking/book/route.ts:816`<br>`apps/api/app/api/appointments/[id]/convert/route.ts:1036`<br>`apps/api/app/api/brush-quote/route.ts:818` | Not found by literal scan |
| `quote.accepted_and_booked.v2` | `apps/api/src/lib/quote-v2-scheduling-service.ts:1659`<br>`apps/api/src/lib/quote-v2-scheduling-service.ts:1664` | `apps/api/src/lib/outbox-processor.ts:5133`<br>`apps/api/src/lib/quote-v2-outbox-worker.ts:709` |
| `quote.change_requested` | `apps/api/app/api/public/quotes/[token]/changes/route.ts:368` | Not found by literal scan |
| `quote.change_requested.v2` | `apps/api/src/lib/quote-v2-public-service.ts:1128`<br>`apps/api/src/lib/quote-v2-public-service.ts:673`<br>`apps/api/src/lib/quote-v2-public-service.ts:907` | `apps/api/src/lib/outbox-processor.ts:5130`<br>`apps/api/src/lib/quote-v2-outbox-worker.ts:683` |
| `quote.decision` | `apps/api/app/api/public/quotes/[token]/route.ts:716`<br>`apps/api/src/lib/notifications.ts:888`<br>`apps/api/src/lib/notifications.ts:922` | `apps/api/src/lib/outbox-processor.ts:5136` |
| `quote.deposit_checkout_requested.v2` | `apps/api/src/lib/quote-v2-deposit-service.ts:349`<br>`apps/api/src/lib/quote-v2-deposit-service.ts:354` | `apps/api/src/lib/outbox-processor.ts:5132`<br>`apps/api/src/lib/quote-v2-outbox-worker.ts:700` |
| `quote.response_recorded.v2` | `apps/api/src/lib/quote-v2-terminal-decision.ts:101`<br>`apps/api/src/lib/quote-v2-terminal-decision.ts:104` | `apps/api/src/lib/outbox-processor.ts:5131`<br>`apps/api/src/lib/quote-v2-outbox-worker.ts:691` |
| `quote.send_requested.v2` | `apps/api/src/lib/quote-v2-issue-persistence.ts:473`<br>`apps/api/src/lib/quote-v2-issue-persistence.ts:478`<br>`apps/api/src/lib/quote-v2-send-attempt-service.ts:1183` | `apps/api/src/lib/outbox-processor.ts:5127` |
| `quote.sent` | `apps/api/app/api/quotes/[id]/send/route.ts:311`<br>`apps/api/src/lib/notifications.ts:745`<br>`apps/api/src/lib/notifications.ts:780` | `apps/api/src/lib/outbox-processor.ts:5086` |
| `review.request` | `apps/api/app/api/appointments/[id]/status/route.ts:1728` | `apps/api/src/lib/outbox-processor.ts:5425` |
| `sales.autopilot.autosend` | `apps/api/src/lib/outbox-processor.ts:3193`<br>`apps/api/src/lib/sales-autopilot.ts:1155` | `apps/api/src/lib/outbox-processor.ts:7478` |
| `sales.autopilot.draft` | `apps/api/src/lib/outbox-processor.ts:7422` | `apps/api/src/lib/outbox-processor.ts:7462` |
| `sales.escalation.call` | `apps/api/src/lib/outbox-processor.ts:1686`<br>`apps/api/src/lib/outbox-processor.ts:1943`<br>`apps/api/src/lib/sales-escalation-call-operations.ts:1962` | `apps/api/src/lib/outbox-processor.ts:5751` |
| `sales.queue.nudge.sms` | Not found by literal scan | `apps/api/src/lib/outbox-processor.ts:6103` |
| `seed.initialized` | `scripts/seed-e2e.ts:354` | Not found by literal scan |
| `staff_notification.dispatch` | `apps/api/src/lib/partner-owner-alerts.ts:386`<br>`apps/api/src/lib/staff-notification-operations.ts:183` | `apps/api/src/lib/outbox-processor.ts:4106` |
