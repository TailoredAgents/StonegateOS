# Winter sale campaign operations

Implemented locally November 11, 2026. Entry point: **Team → Marketing → Campaigns** (`/team/marketing/campaigns`). Nothing in this implementation sends a message just by deploying, creating a draft, selecting customers, or preparing a review.

## What is available

- An editable winter offer with a fixed **40% discount on all services and business-controlled charges**, an Eastern-time booking deadline, and a last service date.
- An audience of past customers with completed jobs, verified marketing consent, a usable phone number, and a recorded recipient timezone. Staff/test numbers, DNC/deleted contacts, unknown/revoked consent and duplicate destinations are excluded. Recent winter campaigns impose a 30-day destination cooldown.
- Exact personalized previews, GSM-7/Unicode segment estimates, configurable estimated costs, allowlisted owner tests, and explicit releases of at most 25 customers. Review snapshots expire after ten minutes. Each next batch needs a new review and release.
- Durable outbox dispatch, consent/lifecycle rechecks, recipient-local 9 a.m.–6 p.m. sending, a configured interval of at least ten seconds, and pause/resume/end controls. A provider submission already claimed cannot be recalled.
- Existing inbox conversations and staff-triggered AI reply suggestions with the offer and deadline. Campaign replies suppress pending promotional messages; competing sales auto-replies/follow-ups are held throughout the active campaign and for recent recipients within 30 days. AI does not release campaigns or send the suggested replies.
- Separate queued, submitted, delivered, failed, uncertain, suppressed, reply and opt-out counts. Tests do not count as customers. Uncertain provider results pause further campaign work and must be reconciled before resuming.
- Schedule checks against appointments, holds, blocks and capacity settings. The panel looks up to 28 days ahead for room for a two-hour job with a 30-minute travel buffer. Candidate dates are not reservations or a count of sellable jobs. Staff still confirms location, scope and crew.
- Quote, booking and collection totals attributed to the frozen offer ID. Collections include tips and subtract completed refunds once. Canceled jobs leave booked totals; money actually collected remains visible until refunded. These are offer totals, not a claim of SMS-caused revenue.

## Pricing behavior

An active or paused, unexpired campaign supplies the public sale when `WINTER_SALE_ENABLED=true`. A draft or owner test does not activate public pricing. Pausing messages preserves the advertised offer; ending the campaign stops new sale pricing.

The shared integer-cent calculation discounts normal prices, including add-ons, travel and fees. $500 becomes $300; $500 plus a $50 fee becomes $330. Other percentage/fixed promotions do not stack. Deposits use the discounted total. No minimum is reapplied after the discount.

Public junk, brush and demolition estimates and the website's load estimator use the offer. Staff Quote V2 documents, customer option totals, rendered proposals/PDFs and their downstream payment totals carry its frozen pricing snapshot. Quote issue expiration is capped at the sale deadline. Instant-estimate handoff supplies normal line prices when making a full quote so the discount is not applied twice.

The owner chooses whether existing unaccepted quotes can be requoted with the offer, or only new quotes qualify. Accepted agreements are not rewritten. Issued/accepted snapshots retain their recorded amounts when the campaign ends.

During an active sale, new/edited legacy quotes direct staff to the current Quotes workspace. Direct staff bookings must originate from a winter quote or an instant quote. This prevents the older manual pricing paths from bypassing the reviewed discount. Existing agreements remain accessible. Additional scope should be quoted and approved through the same current Quotes workflow; staff-entered final totals remain explicit financial decisions and are not automatically discounted again.

Public instant-quote availability, holds and booking reject expired offers and dates after the service cutoff. Quote V2 availability and holds enforce the frozen service cutoff, and issue expiry limits acceptance. Existing appointments are not canceled. Review later reschedules and outstanding commitments in the calendar as part of seasonal shutdown.

## Deployment settings

Migration: `apps/api/src/db/migrations/0184_sms_campaigns.sql`. It adds campaigns, consent evidence, reviews, batches and recipients. Use the existing migration/release procedure and database backup process. Validate the migration inventory before the production migration:

```powershell
corepack pnpm --filter api exec tsx scripts/migrate-to-target.ts latest --validate-files
```

Apply the migration before enabling any of these flags on the API and worker. The checked-in `.env.example` leaves sending and pricing off.

| Setting                                     | Meaning                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SMS_CAMPAIGNS_ENABLED`                     | Enables campaign inbound/opt-out handling and automation suppression after migration.           |
| `SMS_CAMPAIGN_SENDS_ENABLED`                | Allows explicitly released campaign/test messages to proceed. Default false.                    |
| `WINTER_SALE_ENABLED`                       | Enables active campaign pricing lookup. Default false.                                          |
| `SMS_CAMPAIGN_MARKETING_VERIFIED`           | Operator attestation that the actual sender and promotional use case are ready.                 |
| `SMS_CAMPAIGN_PRICING_VERIFIED`             | Release attestation after the live pricing/booking smoke checks below.                          |
| `SMS_CAMPAIGN_TEST_NUMBERS`                 | Comma-separated owner-controlled E.164 numbers; each must match an active contact.              |
| `SMS_CAMPAIGN_INTERVAL_SECONDS`             | Verified sender interval, at least 10 seconds; example defaults to 60.                          |
| `SMS_CAMPAIGN_SEGMENT_PRICE_USD`            | Current estimated all-in per-segment rate from the actual provider account. No hardcoded price. |
| Existing Twilio credentials / `TWILIO_FROM` | Existing SMS transport and verified sender.                                                     |

Existing external-send and outbox kill switches continue to apply. API and worker settings must agree. Enabling a flag does not select recipients or release a batch.

Read access requires `marketing.read`, `contacts.read` and `messages.read`. Mutations require `marketing.write`, `contacts.read` and `messages.read`, with a human principal and the existing idempotency/audit boundary. Consent entry additionally requires `contacts.write`; test/release additionally requires `messages.send` and `policy.write`. Financial/schedule results are returned only with quote, appointment and payment read access. Browser mutations require the correct Site origin.

## Owner launch

1. Set actual expiration and final service dates, quote retroactivity and non-stacking policy. Check remaining crew capacity in the calendar. No date was inferred from “2–3 weeks.”
2. Verify the real sender, campaign registration, rate and timezone rules. Retain each customer's written marketing permission. A CRM phone number or transactional conversation is not an opt-in.
3. In staging, confirm public estimates and a complete issued Quote V2 proposal show normal price, 40% savings and the correct final total, including fees, options and deposit. Verify the cutoff, PDF and payment amounts. Test with synthetic customers/provider mocks before attesting pricing readiness.
4. Deploy with sending off. Apply and verify the additive migration. Configure the real launch settings and owner test allowlist. The application displays missing readiness items.
5. Record existing consent evidence individually. Select customers and review the exact messages and estimated segment cost.
6. Explicitly send an owner test, verify receipt and appearance, then prepare a fresh review if the ten-minute review expired. A successful test of the current terms and sender is required for release.
7. Confirm the selected recipients and capacity; explicitly send the first batch of up to 25. Watch delivery results and work replies in the existing inbox. Do not release the next batch until ready.
8. Use **Pause sending** to hold unclaimed texts. Use **End campaign** when the offer is finished; terms and past delivery evidence remain available.

No customer blast, provider registration, production migration, live pricing change or deployment was performed during local implementation.

## Delivery and recovery

The existing `message.send` outbox and `external_message_dispatches` ledger remain authoritative. No browser-to-provider loop was introduced. Campaign/destination keys, atomic reviewed batches and existing mutation receipts protect retries and double clicks.

Do not blindly resend a provider timeout. An uncertain result is shown separately and requires the existing provider reconciliation workflow. A permanently failed recipient also stays in the campaign's history instead of being silently recycled into a new batch. A cloned campaign does not bypass the cooldown.

STOP, STOPALL, UNSUBSCRIBE, OPTOUT, REVOKE, CANCEL, END and QUIT revoke marketing consent. The existing broader DNC process still applies. Rechecks occur at the final dispatch claim. Once a provider submission is claimed, a later pause/opt-out cannot recall that submission.

Rollback starts by setting `SMS_CAMPAIGN_SENDS_ENABLED=false`, then pausing/ending the campaign. Keep inbound opt-out handling available. Preserve consent, dispatch, quote, payment and audit evidence; do not drop these tables as a rollback. Preserve access for customer replies, refunds and previously accepted commitments through shutdown.

## Local verification

- 18 PostgreSQL-backed verification groups in `scripts/test-sms-campaigns.ts`, including the new SQL migration, concurrent batch release, revocation, quiet hours, destination cooldown, normal dispatch claims, uncertainty, reporting/refunds and frozen-price arithmetic.
- 37 existing focused regression tests covering quote calculations/rendering/scheduling and dispatch/provider certainty. Provider calls are mocked in the certainty tests.
- Browser checks in `scripts/test-sms-campaign-browser.mts`: create/save draft, dates/policies, recipient selection, exact review, disabled live sending, anonymous access and cross-origin rejection. Checked 320px, 390px and 1440px widths without horizontal overflow or browser errors.
- API/site typechecks, targeted lint and production builds. Evidence logs/screenshots are in ignored `artifacts/campaign-*` files.

Integration tests require an intentionally disposable database named `campaign_integration` on `127.0.0.1:5446`; the script refuses other targets and truncates synthetic campaign/customer data. The local test schema came from the checked-in schema, with the new migration also exercised in a fresh isolated schema. This is not evidence that a production migration or real carrier delivery has occurred.

```powershell
# Only with the disposable local PostgreSQL test instance running:
$env:DATABASE_URL='postgres://postgres:campaign-local-only@127.0.0.1:5446/campaign_integration'
$env:DATABASE_SSL='false'
corepack pnpm exec tsx scripts/test-sms-campaigns.ts
```

The browser test expects the isolated API on port 3201, Site on port 3200, live sends disabled, and a seeded local preview owner session. It creates draft records only. The token used by that test belongs only to the synthetic local database and must never be seeded in production.

Provider references checked November 11, 2026: [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) for promotional consent, sender identification and opt-outs; [Twilio scaling guidance](https://www.twilio.com/docs/messaging/guides/best-practices-at-scale) for sender-dependent throughput. The local 9 a.m.–6 p.m. window is an operational default, not a claim about every jurisdiction's rules.
