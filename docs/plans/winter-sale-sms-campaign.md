# Winter sale SMS campaign implementation plan

Status: implemented and verified locally; production deployment and owner launch are pending.

Implementation notes and launch procedure: [winter sale runbook](../runbooks/winter-sale-campaign.md).

Prepared: November 11, 2026.

## Objective and approved direction

Build a small Campaigns workspace inside StonegateOS so the owner can select eligible customers, review a winter promotion, send a test, and manually release batches of individual SMS messages. Replies stay in the existing inbox. Quotes and booking records must honor the same promotion.

Decisions already made by the owner:

- The offer is **40% off across the board**. Do not substitute a smaller discount, impose a discount cap, or quietly exclude services.
- Use the existing system and texting infrastructure.
- Launch manually and send in controlled batches; proposed first batch is 25 recipients.
- AI assists with drafts and replies; the owner controls the offer, sending, pricing, and bookings.
- Customer copy describes a winter sale. Do not mention internal uncertainty about future operations or promise a reopening date.

The owner subsequently authorized local implementation with “Please proceed with your plan.” The feature has been built for review. Customer messages, production deployment/migration, live pricing activation and bookings still require the explicit launch workflow; none occurred during implementation.

## Required inputs before launch

These do not block building the feature with draft values, but must block a real launch if missing:

- Exact sale expiration date/time and last eligible service date, displayed in America/New_York.
- Remaining service capacity and actual bookable dates. The earlier “2–3 weeks” is not a calendar cutoff.
- Verified sender number, promotional messaging configuration, provider throughput limits, and current pricing for a cost estimate.
- Verified SMS marketing consent evidence for each recipient; having a phone number, requesting a quote, or receiving transactional texts is not sufficient evidence by itself.
- Whether already-issued quotes or already-booked jobs receive the promotion retroactively. Do not silently alter existing agreements.
- How other promotions interact with this one. Proposed default is one winter discount per quote, without automatic stacking; show that decision for owner review.
- Confirm how taxes, if any, are calculated using the existing billing rules. All business-controlled service charges must be included in the advertised discount; do not hide exclusions in fees.

No customer counts, consent coverage, available slots, provider readiness, or current SMS prices have been verified for this plan.

## Existing code to reuse

Paths below are repository-relative. Verify the active runtime paths before implementing; some legacy and V2 workflows coexist.

| Area                                        | Existing integration points                                                                                       | Implementation implication                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contacts, conversations, dispatches, outbox | `apps/api/src/db/schema.ts`                                                                                       | Extend existing records rather than create a separate contact database.                                                                          |
| Contact validation and lifecycle            | `apps/api/src/lib/contact-outbound-safety.ts`                                                                     | Reuse phone normalization and contact deletion checks.                                                                                           |
| External message dispatch                   | `apps/api/src/lib/external-message-dispatch.ts`                                                                   | Reuse dispatch claims, delivery evidence, and uncertain-result reconciliation.                                                                   |
| SMS transport                               | `apps/api/src/lib/messaging.ts`                                                                                   | Preserve provider abstraction and existing external-send controls.                                                                               |
| Outbox execution                            | `scripts/outbox-worker.ts`                                                                                        | Add a campaign event handler to the established worker flow.                                                                                     |
| SMS webhooks                                | `apps/api/app/api/webhooks/twilio/sms/route.ts`, `apps/api/app/api/webhooks/twilio/notice/route.ts`               | Inspect existing inbound/status routing before adding campaign attribution and suppression.                                                      |
| Inbox and automation                        | `apps/api/src/lib/inbox.ts`, `apps/api/src/lib/messaging-automation.ts`, `apps/site/src/app/team/inbox-loader.ts` | Reuse conversations and prevent competing sales automations.                                                                                     |
| AI drafting                                 | `apps/api/src/lib/outbound-drafts.ts`                                                                             | Reuse infrastructure, but add a campaign-specific draft contract. Existing outbound prompts prohibit unsolicited pricing and target prospecting. |
| Team mutations                              | `apps/api/src/lib/team-mutation.ts`, `apps/api/src/lib/team-mutation-idempotency.ts`                              | Use established authentication, authorization, transactions, and replay protection.                                                              |
| Quote calculations                          | `apps/api/src/lib/quote-v2-domain.ts`, `apps/api/src/lib/quote-v2-staff-service.ts`                               | Reuse integer-cent/basis-point arithmetic; inspect how subtotal, fee, and travel adjustments interact.                                           |
| Public estimates                            | `apps/api/src/lib/junk-volume-pricing.ts`, public quote routes                                                    | Trace every active estimate and booking entry point before applying the promotion.                                                               |
| Team workspace routing                      | `apps/site/src/app/team/page.tsx`, `apps/site/src/app/team/surface-loaders.tsx`                                   | Fit Campaigns into the existing workspace navigation and permissions.                                                                            |

The existing outbound bulk route manages prospecting tasks; it is not proof of a ready-to-use customer SMS broadcast feature. Existing do-not-contact checks are useful, but must not be mistaken for a marketing-consent ledger.

## Operator experience

Implement one focused campaign detail workflow rather than a general marketing platform.

1. **Create draft:** campaign name, 40% offer, expiration, final service date, template, and sender.
2. **Select audience:** eligible customers with normalized numbers; search, select, and exclude. Show eligible, selected, and excluded counts with exclusion reasons. Do not preselect every phone number in the CRM.
3. **Review:** show the full selected audience, exact personalized messages, terms, sender, estimated SMS segments/cost, and first batch size. Use a neutral greeting when a name is missing.
4. **Test:** send the reviewed message only to an owner-selected test number through an explicit action. Tests must not consume audience slots or inflate campaign results.
5. **Launch first batch:** owner explicitly releases up to 25 reviewed recipients. The interface immediately shows queued/sent/delivered/failure states.
6. **Work replies:** open the existing inbox filtered to this campaign. Show unread replies, interested customers, quotes, bookings, and opt-outs.
7. **Release next batch:** show remaining audience, unresolved replies, schedule capacity, and current campaign terms before another manual action.
8. **Pause or end:** a persistent Pause control stops unclaimed sends. Explain that a message already submitted to the provider cannot be recalled. Ending cancels remaining promotional sends but retains history and ordinary service communication.

Keep Accept/Launch actions explicit. No automatic release of the next batch, campaign cloning to bypass suppression, or hidden bulk sends. Design for desktop and mobile, with recipient counts and pause controls easy to see.

## Audience and consent

- Inspect where consent evidence currently lives. If necessary, add a narrowly scoped SMS marketing consent ledger containing contact/normalized destination, purpose, status, source, captured timestamp, evidence reference, and revocation timestamp.
- Preserve evidence; never manufacture opt-in records or bulk-mark historical contacts as consented.
- Classify candidates as eligible, unknown consent, opted out/DNC, invalid number, deleted contact, duplicate destination, already contacted in this campaign, or manually excluded.
- Deduplicate by normalized phone number across contacts and contact merges. A new contact ID must not allow a second campaign send to the same number.
- Exclude staff/test numbers from the customer audience. Past customers are the initial audience; do not mix unrelated prospecting imports into it automatically.
- Recheck consent, DNC, contact lifecycle, destination, campaign status, expiration, and prior-send status at dispatch time, not just when previewing.
- Campaign messages must never use the manual inbox DNC override.
- Handle standard opt-out keywords and the existing broader opt-out process. Record suppression before any pending promotional send can proceed. A reply or booking also suppresses any future promotional follow-up for this campaign.
- Do not send a promotional “permission request” to the unknown-consent group as a workaround.
- Verify current provider requirements at implementation/launch using the [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy). Provider registration and business consent evidence are separate checks.

## Proposed persistence and API shape

Prefer extending existing structures where they already provide the required invariant. Names below are provisional.

- `sms_campaigns`: name, lifecycle state, version, sender reference, frozen terms/template revision, start/expiration/service-cutoff timestamps, batch size, creator, and lifecycle audit timestamps.
- `sms_campaign_recipients`: campaign, contact reference, normalized destination snapshot, consent evidence reference, exact approved rendered message, exclusion/suppression reason, conversation reference, and send/batch state. Enforce campaign-plus-destination uniqueness.
- `sms_campaign_batches`: campaign revision, selected recipient IDs, requested count, approving actor, idempotency key, and release time. Persist the released set atomically.
- Reuse existing dispatch/message/delivery-event records for provider IDs, attempts, status history, and reconciliation rather than storing conflicting copies of delivery truth.
- A promotion record or frozen campaign offer snapshot must also identify discount version and quote attribution. Message delivery and promotion eligibility are separate concepts; 40% across the board must not become a secret recipient-only discount.

Campaign states: `draft`, `ready`, `active`, `paused`, `completed`, `cancelled`, `expired`. Delivery state and engagement state should be separate: a delivered message can later receive both a reply and a booking.

Proposed staff API capabilities: list/create/update draft, audience preview, review snapshot, test send, release batch, pause/resume/end, metrics, and recipient status. Use the established site-to-API proxy pattern and require appropriate staff capabilities on every mutation.

Bind a batch release to the reviewed campaign revision and audience snapshot. Changes to message, offer, dates, sender, or recipients invalidate the old review. A browser retry, double click, or second worker must not release the same batch twice.

## Delivery and reliability

- Queue sends through the existing outbox and external-dispatch layer; do not loop over contacts and call the provider directly from a browser/API request.
- Release only the chosen batch. Rate-limit using verified sender limits, respect configured sending windows, and do not infer a recipient timezone solely from their phone area code. If the permitted window is unknown, hold rather than guess.
- Use unique logical send keys per campaign/destination/message purpose. Preserve them across worker retries.
- Perform final eligibility checks immediately before provider submission. Serialize opt-out/pause transitions with dispatch claims using established transaction patterns; make the unavoidable already-submitted boundary visible.
- Provider timeouts can mean a message was accepted. Use the existing `reconciliation_required` behavior instead of blindly retrying uncertain sends. Do not claim end-to-end exactly-once delivery where the provider cannot guarantee it.
- Process authenticated callbacks idempotently; retain history and avoid regressing delivered messages on stale/out-of-order status events.
- Pause or alert on provider configuration failures, unusual delivery failures, or scheduling capacity exhaustion. A delayed worker must never release an expired campaign.
- Estimate message segments after personalization, accounting for GSM-7 versus Unicode encoding. Show pricing assumptions and mark costs as estimates; avoid logging full customer numbers or sensitive content unnecessarily.

## Discount and booking consistency

Implement one authoritative promotion calculation shared by all active quote flows. Percentage is 4,000 basis points; perform rounding in integer cents under the established pricing convention.

- Apply the discount to all offered services and business-controlled charges. Quote V2 currently separates subtotal discounts from fee/travel adjustments, so a subtotal-only adjustment may not satisfy “across the board.” Resolve that explicitly and test it.
- Compute the ordinary price first, then the discount. Preserve ordinary pricing rules but do not reapply an undisclosed minimum after discounting or add an offsetting fee.
- Display normal amount, “Winter sale — 40% off,” savings, and final amount in customer-facing quotes. Example: $500 normal amount, $200 discount, $300 final amount before any applicable tax calculation.
- Cover instant estimates, staff-created quotes, relevant legacy/V2 proposals, booking handoff, PDFs, deposits, final invoices, and additional approved scope. Trace active paths instead of assuming V2 handles all business.
- Snapshot terms and calculations on issued quotes. Expiring or editing a campaign must not silently reprice a quote already accepted by a customer.
- Enforce the actual last service date on new campaign bookings. Do not cancel existing bookings or promise unsupported appointment availability.
- Apply the same public sale terms to eligible website and staff quotes, even if the customer did not arrive through a tracked SMS link. Campaign attribution should track origin without changing offer fairness.
- Use opaque tracking links if needed; do not put phone numbers or names into URLs. Links must not reveal private quote details without existing authorization.

If any active quote/payment path cannot honor the discount correctly, keep launch disabled until it can. Do not send the promotion with a plan to repair pricing afterward.

## Inbox and AI assistance

- Attach campaign context to messages and existing conversations; do not fork a second inbox or duplicate a customer's history.
- Show the offer, service deadline, original text, and relevant job history to staff. Attribute replies carefully if a contact has multiple campaigns/conversations; do not assign revenue based solely on last message time.
- AI may suggest replies, request photos in a draft, summarize scope, and suggest appointments from verified availability.
- Require staff to send AI-generated replies in the first version. Initial campaign copy is a reviewed template with limited personalization, not unrestricted per-customer generation.
- Treat incoming messages and uploaded content as untrusted input. AI cannot alter the 40% offer, infer consent, override opt-outs, book unverified dates, or disclose internal business plans.
- Add campaign awareness to existing automation so unrelated follow-up sequences do not send competing messages to engaged campaign recipients. Leave necessary service notifications working.

## Reporting

Show unique recipients selected, queued, submitted, delivered, failed, uncertain, suppressed, replied, quoted, and booked. Distinguish provider acceptance from confirmed delivery; SMS does not provide a reliable read/open count.

Show quoted value, booked value after discount, and collected revenue separately. Link metrics to source records; account for cancellations, refunds, duplicate callbacks, and contact merges. Count tests separately. A capacity panel should reflect real appointments and resources rather than equating message count to job capacity.

## Implementation sequence

- [x] **1. Confirm integration paths:** inspect current messaging configuration, permissions, consent storage, active quote flows, worker handlers, and schedule capacity source. Record gaps without contacting customers.
- [x] **2. Add persistence and eligibility:** migrations, consent evidence where missing, campaign/recipient/batch records, normalization, suppression, and authorization.
- [x] **3. Implement the shared 40% promotion:** consistent calculations and snapshots across active estimates, quotes, booking, and payment surfaces. Validate date rules and no hidden exclusions.
- [x] **4. Build draft/review UI:** recipient selection, exclusion explanations, exact personalized previews, terms, segment/cost estimate, versioned review, and test-number selection.
- [x] **5. Add explicit sending controls:** test action, atomic batch release, outbox dispatch, throttling, pause/resume/end, eligibility rechecks, and uncertain-send reconciliation.
- [x] **6. Integrate replies and results:** campaign inbox filters, opt-out suppression, delivery statuses, appointment attribution, and accurate reporting.
- [x] **7. Add AI draft assistance:** campaign-grounded drafts and job summaries using the existing AI infrastructure. Keep sends under staff control.
- [x] **8. Verify the complete flow locally/staging:** fake providers and synthetic customers first; prepare migrations, rollback instructions, and a production launch checklist.
- [ ] **9. Owner launch:** enter final dates, verify eligible audience and capacity, explicitly send an owner test, review the final first batch, and manually release it.

Avoid building email campaigns, recurring marketing sequences, autonomous negotiations, a new CRM, or a generalized campaign designer for this short-window use case.

## Acceptance tests

Use targeted unit/integration tests for financial and delivery invariants, plus browser tests of the operator flow. No test may contact a real customer.

- Eligibility rejects unknown consent, revoked consent, DNC, deleted contacts, invalid numbers, duplicate normalized destinations, and previously sent campaign recipients.
- Audience review cannot become a send when its revision is stale. Unauthorized users cannot preview sensitive audiences or launch/pause campaigns.
- Double-clicked releases, concurrent workers, process restarts, and retried requests do not create duplicate logical sends.
- STOP/revocation between preview and dispatch suppresses the send. Pause/expiration blocks unclaimed work. Unknown provider outcomes require reconciliation rather than automatic resend.
- Callbacks are authenticated, deduplicated, and robust to out-of-order events. Failed/uncertain/accepted/delivered remain distinguishable.
- The first release contains no more than its approved 25 recipients; no second batch starts automatically. Tests never count as customer sends.
- Discount calculations cover odd-cent rounding, price ranges, add-ons, fees/travel, existing minimums, and repeat application. An accepted quote remains stable when the campaign ends.
- Sale deadlines and service cutoffs enforce the configured timezone. Full capacity and dates after closure cannot be offered as available.
- Replies appear in the existing inbox; AI drafts preserve the offer, do not send themselves, and resist customer-provided instructions to change pricing or override controls.
- Desktop/mobile checks cover audience selection, review, test action, batch release, pause, exclusion explanations, error recovery, and keyboard access.
- Run focused API/site tests, affected typechecks/lint, and production builds appropriate to the changed code. Use isolated test databases for migrations and concurrency checks.

## Release, shutdown, and recovery

- Gate live campaign sending behind a default-off feature flag and existing provider-send controls. Deploying code must not release a draft or queued audience automatically.
- Use additive migrations where possible. Back up and verify migrations using the repository's release procedure; do not alter production data during local implementation.
- Rollback starts by disabling campaign dispatch and cancelling/holding unclaimed campaign events. Preserve delivery history, opt-outs, issued offers, and audit evidence; sent messages cannot be recalled.
- Before closure, expire the sale, stop promotional work, and enforce the actual service cutoff. Preserve access for outstanding customer replies, payments, refunds, and commitments.
- Definition of done: the owner can review and explicitly launch a 25-recipient campaign, pause remaining work, manage replies in the current inbox, and issue consistently discounted quotes with reliable delivery/accounting evidence.

## Resume notes for a future implementation session

Read this plan, inspect current `git status`, and check any newly applicable `AGENTS.md` instructions before editing. Preserve the existing public-site redesign and compact cookie-notice changes in this working tree. At plan creation, these were still uncommitted. Do not reset or bundle unrelated work into campaign changes without reviewing it.

Steps 1–8 are implemented locally. Resume with the runbook and current git status, preserving the public-site work. Step 9 remains the owner launch; actual dates, consent coverage, provider configuration and production readiness have not been verified.

Implementation choices: ready/expired behavior is derived from readiness and deadline checks rather than separate stored states; replies open the existing conversation from each result; reporting attributes the frozen offer, not an assumed SMS conversion; current Quotes handles new sale proposals while legacy editing/direct manual booking paths direct staff through reviewed quotes during an active sale. Capacity is a real schedule check for standard job duration, followed by human confirmation. Additional scope and final financial adjustments remain staff-reviewed. See the runbook for precise boundaries and verification evidence.
