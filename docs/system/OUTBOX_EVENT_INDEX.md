# Outbox Event Index

Generated: 2026-03-07 13:37:33 (Eastern Standard Time)

Outbox events are durable async jobs stored in `outbox_events` and processed by the worker via `StonegateOS/apps/api/src/lib/outbox-processor.ts`.

| Type | Queued By (examples) | Outbox Processor handler |
|---|---|---|
| `call.recording.delete` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:4165` |
| `call.recording.process` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3799` |
| `contact.alert` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2878` |
| `crm.reminder.sms` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3218` |
| `estimate.reminder` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3610` |
| `estimate.requested` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2327` |
| `estimate.rescheduled` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2445` |
| `estimate.status_changed` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2576` |
| `followup.schedule` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3647` |
| `followup.send` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3661` |
| `google.ads_analyst.run` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3570` |
| `google.ads_insights.sync` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3521` |
| `lead.alert` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2766` |
| `lead.created` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2577` |
| `message.received` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:4220` |
| `message.send` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:4272` |
| `meta.ads_insights.sync` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3470` |
| `meta.lead_event` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3356` |
| `pipeline.auto_stage_change` |  | (no case found) |
| `quote.decision` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2530` |
| `quote.sent` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2490` |
| `review.request` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2658` |
| `sales.autopilot.autosend` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:4260` |
| `sales.autopilot.draft` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:4249` |
| `sales.escalation.call` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:2903` |
| `sales.queue.nudge.sms` |  | `StonegateOS/apps/api/src/lib/outbox-processor.ts:3110` |
