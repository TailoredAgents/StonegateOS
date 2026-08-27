# Production Expense Tracking V2

This document is the implementation checklist and production-readiness record for Expense Tracking V2. It is intentionally scoped to expense tracking.

## Completion rule

- A checklist item may only change to `[x]` after its implementation has been verified.
- Every completed item must replace `Verification: Pending.` with concrete evidence such as a test name, command result, migration check, screenshot, or production observation.
- A passing typecheck alone is not sufficient verification for a business rule.
- Feature flags remain off until the applicable rollout gate has passed.

## Locked business rules

- Monday-Sunday reporting in `America/New_York`.
- Revenue uses final totals from jobs completed during the selected week.
- Labor is accrued to the week worked, including crew, sales, and management compensation.
- Category rows show both percentage of expenses and percentage of revenue.
- Manual Facebook/Google values are authoritative; imported provider data never affects totals.
- Crew submit expenses for approval; owners approve. Owner-created expenses post immediately after confirmation.
- Employee-paid purchases enter the reimbursement workflow without duplicating the expense.
- Historical weeks use verified records only and display an incomplete-data warning where necessary.

## Implementation checklist

### Financial data and controls

- [ ] Add stable expense category IDs, aliases for current labels, and seeded categories: Dump Fees, Fuel, Meals, Equipment, Vehicle, Insurance, Software, Advertising, Supplies, Tolls/Parking, Subcontractors, Office/Admin, Other, and legacy Reimbursements.
  - Verification: Pending.
- [ ] Add expense allocations so one receipt can optionally be split across categories; allocations must exactly equal the expense total.
  - Verification: Pending.
- [ ] Add submitter, payer type (`company` or `personal`), paid-by member, review status, reviewer, source, and receipt-capture references.
  - Verification: Pending.
- [ ] Add permissions for `expenses.submit`, `expenses.approve`, `financials.read`, and `ad_spend.write`. Crew see only their submissions; Overview and daily ad spend remain owner-only.
  - Verification: Pending.
- [ ] Keep existing expense lifecycle, idempotency, immutable corrections, audit history, and legacy receipt compatibility.
  - Verification: Pending.
- [ ] Migrate known category labels through aliases; preserve unknown historical labels and flag them rather than guessing.
  - Verification: Pending.
- [ ] Store new receipt originals and normalized derivatives in private R2 instead of PostgreSQL data URLs. Retain legacy receipt fallback while old files are migrated and verified in batches.
  - Verification: Pending.

### Receipt scanning and approval

- [ ] Add an expense-capture API for upload intent, upload finalization, analysis status, confirmation, and discard.
  - Verification: Pending.
- [ ] Reuse the current signed-upload, hashing, HEIC/orientation, IndexedDB, and background-sync foundations through generalized binary-upload utilities.
  - Verification: Pending.
- [ ] Process receipts asynchronously in the worker; API requests must not wait for AI.
  - Verification: Pending.
- [ ] Extract vendor, transaction date, total, tax, payment last four, suggested category, optional line items, warnings, and per-field confidence using image input and strict structured output. The Responses integration must support image input and structured JSON output.
  - Verification: Pending.
- [ ] Add `OPENAI_EXPENSE_MODEL`, falling back to the existing configured model, and send `store: false`.
  - Verification: Pending.
- [ ] Never invent missing values. Missing or low-confidence totals and dates remain blank and visibly marked **Check this**.
  - Verification: Pending.
- [ ] Require human confirmation before any expense posts. AI can only prefill the form.
  - Verification: Pending.
- [ ] Detect exact duplicates by SHA-256 and fuzzy duplicates by normalized vendor, total, and nearby date. Exact duplicates require owner override with a recorded reason.
  - Verification: Pending.
- [ ] Learn from approved corrections using vendor/category rules. Apply an owner-locked rule first, then a rule with at least three approved confirmations and 80% agreement, then the AI suggestion. Do not automatically retrain a model.
  - Verification: Pending.
- [ ] For company-paid submissions, owner approval posts the expense.
  - Verification: Pending.
- [ ] For personal submissions, owner approval posts the underlying categorized expense and creates one reimbursement claim referencing that same expense.
  - Verification: Pending.
- [ ] Attach approved claims to the next editable payout as adjustments. Never create a second reimbursement expense. Claims approved after a payout locks move to the next payout.
  - Verification: Pending.

### Mobile experience

- [ ] Keep one top-level **Spend** destination; do not add another bottom-navigation item.
  - Verification: Pending.
- [ ] Add a three-option segmented control: **Add**, **Overview**, **History**. Default to Add.
  - Verification: Pending.
- [ ] Add shows exactly three choices: **Scan receipt** as the primary action, **Daily ad spend**, and **Manual entry**.
  - Verification: Pending.
- [ ] Once a workflow opens, hide the other choices and use no more than one filled primary button per screen.
  - Verification: Pending.
- [ ] Receipt flow: rear camera -> preview -> extraction -> compact review -> submit. Review shows vendor, date, total, category, and who paid; notes, payment method, job link, and category splitting live under **More details**.
  - Verification: Pending.
- [ ] Manual flow shows date, amount, category, and who paid first; all optional fields stay collapsed.
  - Verification: Pending.
- [ ] History shows status, submitter, amount, category, receipt, and reimbursement state. Owners see pending reviews first; crew see only their entries. Use one filter control and no bulk-approval action.
  - Verification: Pending.
- [ ] Offline captures persist by employee, survive reloads, and retry after reconnection. Display **Waiting to sync**, never **Saved**, until acknowledged by the server.
  - Verification: Pending.
- [ ] Preserve existing appointment-photo queues when upgrading IndexedDB and the service worker.
  - Verification: Pending.
- [ ] Meet mobile accessibility requirements: 44px targets, visible focus, proper labels, non-color status indicators, `aria-live` processing updates, and VoiceOver/TalkBack coverage.
  - Verification: Pending.

### Daily advertising costs

- [ ] Add a daily-ad registry uniquely keyed by platform and Eastern business date.
  - Verification: Pending.
- [ ] Absence means not entered; an explicit `$0.00` means confirmed zero spend.
  - Verification: Pending.
- [ ] Daily Ad Spend defaults to yesterday and presents one native date input, a Today shortcut, two fixed fields-Facebook and Google-and one **Save ad spend** button.
  - Verification: Pending.
- [ ] Reload and prefill existing values when the date changes.
  - Verification: Pending.
- [ ] Saving a positive value posts an owner-approved Advertising expense with vendor `Meta Ads` or `Google Ads`.
  - Verification: Pending.
- [ ] Changing a saved value uses the ledger's immutable correction/reversal path and updates the registry pointer; it never adds a second active expense.
  - Verification: Pending.
- [ ] Changing a value to zero reverses the prior expense but retains the confirmed-zero registry entry.
  - Verification: Pending.
- [ ] Imported Meta/Google data remains analytics-only and hidden from this v1 interface. It cannot fill, replace, or supplement manual financial totals.
  - Verification: Pending.
- [ ] Show a small missing-yesterday reminder and selected-week completeness warning; tapping it opens the first missing date.
  - Verification: Pending.

## Weekly Overview contract

Add `GET /api/admin/expenses/overview?weekStart=YYYY-MM-DD`, requiring `financials.read`.

The response must include:

- Eastern Monday/Sunday boundaries and completeness state.
- Completed-job revenue using `completedAt` and `finalTotalCents`.
- Ordinary posted expenses by purchase date.
- Accrued labor from persisted appointment commissions.
- Labor subrows for Crew, Sales, Management, and Other Payroll Adjustments.
- Advertising subrows for Facebook and Google.
- Total expenses, operating profit, expenses divided by revenue, and prior-week change.
- Category amount, percentage of total expenses, and percentage of revenue.
- Pending expense count, missing ad-entry dates, and missing commission-data count.

Calculation rules:

- Exclude drafts, rejected submissions, and payout-generated `source='payout_run'` expenses.
- Include employee-paid purchases in their original category and purchase week.
- Never count reimbursement adjustments as a second expense.
- Use finalized payout data when available; otherwise use persisted commission rows and label Labor **Estimated**.
- Label Labor **Actual** once the week's payout is locked or paid.
- Return percentages as `null`/`-` when their denominator is zero.
- Show incomplete historical weeks but never estimate missing records.

The Overview UI uses previous/date/next week controls, four headline values-Revenue, Expenses, Operating Profit, Expense Ratio-and ranked horizontal category bars. It does not use a pie chart.

### Weekly Overview implementation

- [ ] Implement the weekly Overview API contract and require `financials.read`.
  - Verification: Pending.
- [ ] Use Eastern Monday/Sunday boundaries and `completedAt` plus `finalTotalCents` for completed-job revenue.
  - Verification: Pending.
- [ ] Reconcile ordinary expenses, allocations, accrued labor, ads, corrections, and reimbursements without double counting.
  - Verification: Pending.
- [ ] Return labor and advertising subrows, completeness metadata, pending count, missing ad dates, and missing commission count.
  - Verification: Pending.
- [ ] Return null percentages for zero denominators and prior-week change with an explicit zero-baseline state.
  - Verification: Pending.
- [ ] Build the four-value mobile Overview with previous/date/next controls and ranked horizontal category bars.
  - Verification: Pending.

## Verification and production rollout

- [ ] Unit-test receipt schemas, confidence handling, vendor learning, allocation totals, duplicate detection, daily-ad uniqueness, corrections, reimbursements, and all weekly calculations.
  - Verification: Pending.
- [ ] Test DST boundaries, zero revenue, zero expenses, corrected/voided entries, missing commission rows, late reimbursements, and paid-payroll double-count prevention.
  - Verification: Pending.
- [ ] Integration-test owner immediate posting, crew pending approval, rejection, permission isolation, reimbursement attachment, payout locking, ad correction to zero, and idempotent retries.
  - Verification: Pending.
- [ ] E2E-test iOS Safari/PWA and Android Chrome/PWA for camera denial, HEIC, PDF, glare, rotation, offline capture, expired sessions, reload during analysis, and storage pressure.
  - Verification: Pending.
- [ ] Build a reviewed benchmark of at least 100 representative receipts. Require at least 98% exact total extraction and 95% date/vendor extraction before crew rollout.
  - Verification: Pending.
- [ ] Confirm an extracted receipt can never post without review and exact duplicate uploads cannot create duplicate expenses.
  - Verification: Pending.
- [ ] Confirm Overview reconciles exactly against fixture revenue, allocations, labor, ads, corrections, and reimbursements.
  - Verification: Pending.
- [ ] Release behind separate receipt, ad-spend, reimbursement, and Overview flags.
  - Verification: Pending.
- [ ] Deploy in order: database expansion -> API -> worker -> site.
  - Verification: Pending.
- [ ] Pilot owner-only scanning with 30-50 receipts, then enable owner ad entry and Overview, then crew submission.
  - Verification: Pending.
- [ ] Monitor analysis latency/failures, correction rate, duplicate warnings, unsynced queue age, pending approvals, missing ad days, reimbursement backlog, and incomplete overview weeks.
  - Verification: Pending.
- [ ] Keep the existing manual expense path available as rollback; disabling flags must not hide or corrupt captured ledger data.
  - Verification: Pending.

## Explicit defaults

- USD only.
- Receipt limit remains 10 MB; accept verified JPEG, PNG, WebP, HEIC, and PDF.
- Original receipt evidence is immutable.
- Optional category splitting is hidden under **More details**.
- No automatic provider-based ad expense creation.
- No automatic bulk approval or AI posting.
- No estimated historical backfill.
- Job-level profitability, formal tax filing, and automated accounting-platform export are outside this release.

## Rollout record

| Stage | Status | Verification notes |
| --- | --- | --- |
| Database expansion | Pending | Pending. |
| API | Pending | Pending. |
| Receipt analysis worker | Pending | Pending. |
| Mobile site | Pending | Pending. |
| Owner receipt pilot | Pending | Pending. |
| Owner ad spend and Overview | Pending | Pending. |
| Crew submissions | Pending | Pending. |

## Deferred/out of scope

- Job-level profitability.
- Formal tax filing.
- Automated accounting-platform export.
- Automatic provider-created advertising expenses.
- Automatic approval or posting from AI output.
