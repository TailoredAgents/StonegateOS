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

- [x] Add stable expense category IDs, aliases for current labels, and seeded categories: Dump Fees, Fuel, Meals, Equipment, Vehicle, Insurance, Software, Advertising, Supplies, Tolls/Parking, Subcontractors, Office/Admin, Other, and legacy Reimbursements.
  - Verification: Migrations `0102_expense_tracking_v2_foundation.sql` and `0107_expense_dump_alias_and_backfill.sql` passed both a clean PostgreSQL migration and a populated `0101` production-prefix upgrade containing posted, draft, known-label, and unknown-label expenses. The regression verifies exact allocations, unchanged ledger evidence, restored immutability guards, and is required by CI alongside `expense-v2-foundation.test.ts` and `expense-v2-database-guards.integration.test.ts`.
- [x] Add expense allocations so one receipt can optionally be split across categories; allocations must exactly equal the expense total.
  - Verification: Database allocation guards and submission transactions passed in `expense-v2-database-guards.integration.test.ts` and `expense-submission-workflow.integration.test.ts`; client exact-cent validation passed in `mobile-spend-v2.test.ts`.
- [x] Add submitter, payer type (`company` or `personal`), paid-by member, review status, reviewer, source, and receipt-capture references.
  - Verification: Schema/migration contract passed in `expense-v2-foundation.test.ts`; owner, crew, and personal-payer persistence passed in `expense-submission-workflow.integration.test.ts`.
- [x] Add permissions for `expenses.submit`, `expenses.approve`, `financials.read`, and `ad_spend.write`. Crew see only their submissions; Overview and daily ad spend remain owner-only.
  - Verification: `permissions.test.ts`, `access-role-templates.test.ts`, `expense-submission-workflow.integration.test.ts`, and route access tests passed; legacy read/summary/export routes explicitly reject crew.
- [x] Keep existing expense lifecycle, idempotency, immutable corrections, audit history, and legacy receipt compatibility.
  - Verification: `expense-managed-mutation.test.ts`, `expense-managed-lifecycle.integration.test.ts`, `expense-integrity.test.ts`, and `legacy-expense-receipt-backfill.test.ts` passed, including correction/reversal and ambiguous-commit evidence retention.
- [x] Migrate known category labels through aliases; preserve unknown historical labels and flag them rather than guessing.
  - Verification: Alias/backfill migrations applied cleanly; unknown-label completeness behavior passed in `expense-overview-repository.test.ts` and database guard coverage.
- [x] Store new receipt originals and normalized derivatives in private R2 instead of PostgreSQL data URLs. Retain legacy receipt fallback while old files are migrated and verified in batches.
  - Verification: `media-storage.test.ts`, `expense-receipt-evidence.test.ts`, `expense-receipt-storage.test.ts`, `legacy-expense-receipt-backfill.test.ts`, and `legacy-expense-receipt.test.ts` passed. Originals use write-once conditional PUT plus R2/S3 re-read/hash/MIME verification. The bounded production backfill run remains a rollout task.

### Receipt scanning and approval

- [x] Add an expense-capture API for upload intent, upload finalization, analysis status, confirmation, and discard.
  - Verification: Route and pipeline contracts passed in `expense-receipt-capture-pipeline-contract.test.ts`, `expense-receipt-confirmation.integration.test.ts`, and the API production build/typecheck.
- [x] Reuse the current signed-upload, hashing, HEIC/orientation, IndexedDB, and background-sync foundations through generalized binary-upload utilities.
  - Verification: Appointment media and expense receipts share `binary-upload.ts` hashing/integrity utilities and the existing private `media-storage.ts`; the service worker shares its verified queued-binary materializer. `binary-upload.test.ts`, `expense-receipt-storage.test.ts`, and mobile queue contract tests passed, and the IndexedDB upgrade preserves all appointment stores.
- [x] Process receipts asynchronously in the worker; API requests must not wait for AI.
  - Verification: `expense-receipt-capture-pipeline-contract.test.ts` confirms finalization only enqueues `expense.receipt.analyze`; worker retry/terminal behavior passed in `expense-receipt-analysis-retry.integration.test.ts`.
- [x] Extract vendor, transaction date, total, tax, payment last four, suggested category, optional line items, warnings, and per-field confidence using image input and strict structured output. The Responses integration must support image input and structured JSON output.
  - Verification: Strict request/schema and image/PDF input coverage passed in `expense-receipt-openai.test.ts` and `expense-receipt-domain.test.ts`.
- [x] Add `OPENAI_EXPENSE_MODEL`, falling back to the existing configured model, and send `store: false`.
  - Verification: Configuration fallback and request-body assertions passed in `expense-receipt-openai.test.ts`; environment declarations are present in `.env.example`, `render.yaml`, and `ENV_CATALOG.md`.
- [x] Never invent missing values. Missing or low-confidence totals and dates remain blank and visibly marked **Check this**.
  - Verification: Null/confidence schema tests passed in `expense-receipt-domain.test.ts`; `mobile-spend-v2.test.ts` confirms visible review warnings and required user correction.
- [x] Require human confirmation before any expense posts. AI can only prefill the form.
  - Verification: `expense-receipt-capture-pipeline-contract.test.ts` proves analysis cannot insert/post expenses; `expense-receipt-confirmation.integration.test.ts` verifies posting occurs only through confirmation.
- [x] Detect exact duplicates by SHA-256 and fuzzy duplicates by normalized vendor, total, and nearby date. Exact duplicates require owner override with a recorded reason.
  - Verification: Domain/review tests and `expense-receipt-duplicate-concurrency.integration.test.ts` passed; two simultaneous identical receipts can produce only one posted expense, and overrides are audited with a reason.
- [x] Learn from approved corrections using vendor/category rules. Apply an owner-locked rule first, then a rule with at least three approved confirmations and 80% agreement, then the AI suggestion. Do not automatically retrain a model.
  - Verification: Rule priority, threshold, disagreement, and owner-lock behavior passed in `expense-receipt-domain.test.ts`; the owner-only vendor-rule endpoint persists explicit rules without model training.
- [x] For company-paid submissions, owner approval posts the expense.
  - Verification: Owner-immediate and crew-approval company-paid cases passed in `expense-submission-workflow.integration.test.ts`.
- [x] For personal submissions, owner approval posts the underlying categorized expense and creates one reimbursement claim referencing that same expense.
  - Verification: Single-expense/single-claim behavior passed in `expense-submission-workflow.integration.test.ts` and database uniqueness guards.
- [x] Attach approved claims to the next editable payout as adjustments. Never create a second reimbursement expense. Claims approved after a payout locks move to the next payout.
  - Verification: Draft, locked, paid, late-approval, retry, and no-double-expense transitions passed in `expense-reimbursement-payout-transitions.integration.test.ts` and `expense-managed-lifecycle.integration.test.ts`.

### Mobile experience

- [x] Keep one top-level **Spend** destination; do not add another bottom-navigation item.
  - Verification: `mobile-spend-v2.test.ts` source contract passed and the production site build exposes Expense V2 only inside the existing `/mobile` Spend screen.
- [x] Add a three-option segmented control: **Add**, **Overview**, **History**. Default to Add.
  - Verification: `mobile-spend-v2.test.ts` passed default-state and accessible `aria-pressed` control assertions; the Playwright mobile layout spec covers all three controls.
- [x] Add shows exactly three choices: **Scan receipt** as the primary action, **Daily ad spend**, and **Manual entry**.
  - Verification: `mobile-spend-v2.test.ts` passed the three-choice/one-primary invariant across capability combinations, including disabled rollout states.
- [x] Once a workflow opens, hide the other choices and use no more than one filled primary button per screen.
  - Verification: Mobile source-contract tests passed workflow hiding and singular-primary assertions; `mobile-expense-v2.spec.ts` exercises the manual and daily-ad transitions.
- [x] Receipt flow: rear camera -> preview -> extraction -> compact review -> submit. Review shows vendor, date, total, category, and who paid; notes, payment method, job link, and category splitting live under **More details**.
  - Verification: `mobile-spend-v2.test.ts` passed rear-camera, preview, required review-field, and collapsed-detail contracts; API confirmation tests verify the submitted values.
- [x] Manual flow shows date, amount, category, and who paid first; all optional fields stay collapsed.
  - Verification: `mobile-spend-v2.test.ts` and typed `mobile-expense-v2.spec.ts` passed/compiled against the essential-field and collapsed-details contract.
- [x] History shows status, submitter, amount, category, receipt, and reimbursement state. Owners see pending reviews first; crew see only their entries. Use one filter control and no bulk-approval action.
  - Verification: `expense-submission-history.test.ts`, `expense-submission-workflow.integration.test.ts`, and `mobile-spend-v2.test.ts` passed ordering, isolation, display-field, one-filter, and no-bulk-action assertions.
- [x] Offline captures persist by employee, survive reloads, and retry after reconnection. Display **Waiting to sync**, never **Saved**, until acknowledged by the server.
  - Verification: `mobile-spend-v2.test.ts`, `binary-upload.test.ts`, service-worker syntax validation, and queue-health tests passed persisted employee scoping, terminal/retry state, checksum, and copy contracts.
- [x] Preserve existing appointment-photo queues when upgrading IndexedDB and the service worker.
  - Verification: `mobile-spend-v2.test.ts` verifies all pre-existing stores remain in every upgrade path; the service worker and foreground clients use the same schema version and passed syntax/type checks.
- [ ] Meet mobile accessibility requirements: 44px targets, visible focus, proper labels, non-color status indicators, `aria-live` processing updates, and VoiceOver/TalkBack coverage.
  - Verification: Partial—source-contract tests and the typed mobile Playwright spec verify 44px controls, labels, focus classes, text status, and live regions. Physical VoiceOver and TalkBack passes remain required before rollout.

### Daily advertising costs

- [x] Add a daily-ad registry uniquely keyed by platform and Eastern business date.
  - Verification: Clean migration and database uniqueness checks passed in `expense-v2-foundation.test.ts` and `expense-v2-database-guards.integration.test.ts`.
- [x] Absence means not entered; an explicit `$0.00` means confirmed zero spend.
  - Verification: Null-versus-zero and completeness cases passed in `daily-ad-spend.test.ts` and `expense-overview.test.ts`.
- [x] Daily Ad Spend defaults to yesterday and presents one native date input, a Today shortcut, two fixed fields-Facebook and Google-and one **Save ad spend** button.
  - Verification: `mobile-spend-v2.test.ts` passed the Eastern-yesterday/default-control contract; the typed mobile Playwright spec covers the rendered fields.
- [x] Reload and prefill existing values when the date changes.
  - Verification: Date-triggered GET/prefill behavior passed in `mobile-spend-v2.test.ts` and daily-ad route tests.
- [x] Saving a positive value posts an owner-approved Advertising expense with vendor `Meta Ads` or `Google Ads`.
  - Verification: Both platform cases and owner-only permission enforcement passed in `daily-ad-spend.test.ts` and route tests.
- [x] Changing a saved value uses the ledger's immutable correction/reversal path and updates the registry pointer; it never adds a second active expense.
  - Verification: Correction lineage, pointer replacement, idempotency, and active-expense uniqueness passed in `daily-ad-spend.test.ts` and `expense-v2-database-guards.integration.test.ts`.
- [x] Changing a value to zero reverses the prior expense but retains the confirmed-zero registry entry.
  - Verification: Positive-to-zero correction and confirmed-zero persistence passed in `daily-ad-spend.test.ts`.
- [x] Imported Meta/Google data remains analytics-only and hidden from this v1 interface. It cannot fill, replace, or supplement manual financial totals.
  - Verification: Daily-ad implementation accepts only manual Facebook/Google values; overview repository tests prove totals use only registry-linked ledger expenses.
- [x] Show a small missing-yesterday reminder and selected-week completeness warning; tapping it opens the first missing date.
  - Verification: Missing-date aggregation passed in `expense-overview.test.ts`; reminder/click-through source contracts passed in `mobile-spend-v2.test.ts`.

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

> **Superseded by the Fixed Overhead and Donut addendum below:** the original
> bar-only/no-pie decision remains here as an implementation-history record,
> but it is no longer the active Overview presentation contract.

### Weekly Overview implementation

- [x] Implement the weekly Overview API contract and require `financials.read`.
  - Verification: `expense-overview-route.test.ts`, `permissions.test.ts`, and API type/build checks passed for `GET /api/admin/expenses/overview?weekStart=YYYY-MM-DD`.
- [x] Use Eastern Monday/Sunday boundaries and `completedAt` plus `finalTotalCents` for completed-job revenue.
  - Verification: DST, boundary, completion-time, and final-total cases passed in `expense-overview.test.ts` and `expense-overview-repository.test.ts`.
- [x] Reconcile ordinary expenses, allocations, accrued labor, ads, corrections, and reimbursements without double counting.
  - Verification: Ledger fixture reconciliation passed in `expense-overview.test.ts` and repository tests, including payout-source exclusion, personal-purchase categorization, corrections, and reimbursement adjustment exclusion.
- [x] Return labor and advertising subrows, completeness metadata, pending count, missing ad dates, and missing commission count.
  - Verification: Response-shape and amount assertions passed in overview unit/repository/route tests; actual-versus-estimated labor transitions passed against payout fixtures.
- [x] Return null percentages for zero denominators and prior-week change with an explicit zero-baseline state.
  - Verification: Zero-revenue, zero-expense, unavailable, incomplete, zero-baseline, and undefined-ratio states passed in `expense-overview.test.ts` and `mobile-spend-v2.test.ts`.
- [x] Build the four-value mobile Overview with previous/date/next controls and ranked horizontal category bars.
  - Verification: `mobile-spend-v2.test.ts` passed headline, week-navigation, ranked-bar, completeness-copy, and no-pie-chart contracts; the site production build passed.

## Fixed Overhead and Donut addendum

This addendum supersedes only the earlier bar-only/no-pie Overview rule. The
four headline values, complete ranked category list, category percentages, and
all existing financial-integrity rules remain authoritative.

### Locked fixed-overhead rules

- Owners enter verified monthly fixed costs; the system never guesses or
  backfills a recurring cost.
- Fixed costs accrue by Eastern calendar date. They are not synthetic daily
  ledger rows and do not clutter History.
- A current week accrues fixed costs only through the Eastern as-of date; a
  future week accrues none, while completed historical weeks include all seven
  days. This prevents future overhead from being compared with revenue that has
  not happened yet.
- A full calendar month must reconcile to the exact entered cents. For day
  ordinal `i` in a month with `D` days and monthly amount `M`, daily cents are
  `floor(M * i / D) - floor(M * (i - 1) / D)`.
- Month lengths of 28, 29, 30, and 31 days are supported. DST does not change
  an allocation because every Eastern business date receives one daily share.
- An effective date is inclusive. Revisions and endings append a new version;
  prior financial facts are never edited or deleted.
- The fixed-cost setup flag controls owner setup and mutations only. Once a
  cost exists, disabling the flag must not remove it from Overview totals.
- The setup flag blocks creating or revising schedules and establishing or
  relinking a covered-payment association. An authorized immutable correction
  may preserve or clear an existing association so incorrect reporting can be
  repaired even during rollback.
- Fixed cost accrual is added once to its selected expense category. An owner
  links a payment or receipt for that same bill to the schedule; the evidence
  remains in History while the linked ordinary expense is excluded once.
- The donut visualizes positive category composition only. The exact ranked
  list below it remains the accessible source of truth and shows amount,
  percentage of expenses, and percentage of revenue.
- The five largest positive categories receive direct donut segments; the
  remaining positive categories are grouped as **All other categories** in the
  visual while remaining separate in the ranked list.
- Zero expenses show an explicit empty state. A non-positive or otherwise
  non-representable mix must use explanatory text instead of a misleading
  donut.

### Fixed-overhead implementation checklist

- [x] Add stable fixed-cost series and append-only, effective-dated versions
      with category, exact monthly cents, actor, version, and terminal ended state.
  - Verification: `expense-fixed-cost-migration.test.ts` passed the `0108`
    journal order, table/constraint source contract, append-only triggers,
    contiguous version sequence, monotonic effective dates, and terminal-ended
    guard. Migrations through `0108` applied cleanly to an isolated PostgreSQL
    16 database; a second dry run found no pending migration. The fixed-cost and
    Expense V2 database integration suites passed. Production observation is
    recorded during rollout.
- [x] Validate strict owner inputs and deterministic 28/29/30/31-day
      cumulative-floor proration using safe integer cents.
  - Verification: `expense-fixed-costs.test.ts` passed strict create/revise/end
    validation, date-only validation, deterministic remainder distribution,
    invalid arithmetic inputs, and exact full-month reconciliation across 28,
    29, 30, and 31 days (16 focused cases on 2026-08-27).
- [x] Add owner-only list, create, revise, and end APIs using bounded JSON,
      financial mutation controls, idempotency, optimistic version checks, and
      co-committed audit evidence.
  - Verification: Route contracts, strict validation, historical as-of
    selection, append-only create/revise/end integration, API TypeScript, and
    production API build passed. Production smoke testing remains in rollout.
- [x] Add `fixedCostsCents` to selected/prior week metrics and include it
      exactly once in total expenses, operating profit, expense ratio, category
      totals, and prior-week comparisons.
  - Verification: Overview calculator, repository, and route suites passed
    exact cross-month proration, current-week as-of capping, future-week zero,
    historical full weeks, same-day revision precedence, one-cent monthly
    allocation, category reconciliation, and prior-week comparisons.
- [x] Preserve a fixed-cost-covered payment or receipt as immutable evidence in
      History while excluding that linked ordinary expense exactly once from
      Overview; continue reporting the schedule's daily accrual in its category.
  - Verification: Migration source contracts passed the foreign key, deferred
    exact-allocation/monthly-uniqueness guard, immutable relinking guard, and
    schedule-revision guard; submission schemas passed the exact nullable field
    and implicit one-category allocation. Nine PostgreSQL integration suites
    passed 18 cases against a clean database migrated through `0108`, including
    owner linking, implicit allocation, crew-spoof denial, amount/category/split
    mismatch, one link per series/month, owner approval, rejected submissions
    remaining unlinked, exactly one personal reimbursement, revision guards,
    correction preservation, and explicit unlinking. Overview fixtures
    reconciled `coveredExpenseCount` and `coveredExpenseAmountCents` without
    changing fixed-cost accrual. Mobile source contracts passed the optional
    selector under **More details**, approval-time linking, the History evidence
    link and exclusion label, and the compact Overview exclusion summary.
    Playwright passed the complete expense spec in both Chromium Pixel 7 and
    WebKit iPhone 13 projects (4/4). A real-backend receipt-confirmation link and
    inactive-date route case remain part of the broader rollout matrix.
- [x] Add one owner-only **Fixed monthly costs** management row inside Overview;
      keep Add limited to Scan receipt, Daily ad spend, and Manual entry.
  - Verification: Mobile contract tests passed owner-only permissions, exact
    three-choice Add navigation, 44px controls, create/revise/end idempotency,
    optimistic versions, duplicate-entry warning, and live status regions. The
    mobile Playwright add/revise/end flow passed in Chromium Pixel 7 and WebKit
    iPhone 13 projects. Physical-device testing remains part of rollout.
- [x] Replace the ranked-bar-only presentation with a smooth, accessible donut
      plus the complete percentage list, stable category colors, reduced-motion
      behavior, and zero/non-representable fallbacks.
  - Verification: Donut unit/render tests passed top-five-plus-Other grouping,
    stable ID-based colors, exact full list, expense/revenue percentages,
    decorative SVG semantics, reduced motion, zero state, and an accurate
    net-adjustment fallback that refuses to draw a misleading chart. The full
    list and chart passed Chromium Pixel 7 and WebKit iPhone 13 navigation;
    physical iOS/Android screen-reader validation remains part of rollout.
- [x] Gate fixed-cost setup independently with
      `EXPENSE_FIXED_COSTS_ENABLED`, while continuing to count already-recorded
      fixed costs when setup is disabled.
  - Verification: `expense-feature-flags.test.ts` passed independent
    production-default-off and enabled-state coverage; capability route tests
    require approval, financial read, and the flag. The flag blocks schedule
    mutations and establishing or relinking non-null coverage; an authorized
    correction can preserve or clear an existing link. Overview storage reads
    are deliberately independent of this setup flag, so disabling setup cannot
    erase accrued overhead. Production rollback remains part of rollout.
- [ ] Roll out database -> API -> site -> owner flag, enter verified current
      costs, and reconcile at least one cross-month week before relying on the
      operating-profit result.
  - Verification: Partial—migration `0108` and the fixed-cost API/site shipped
    in commit `0c2a4b8e`; `EXPENSE_FIXED_COSTS_ENABLED=1` is live. No fixed-cost
    rows were entered during deployment. Owner-entered data, a cross-month
    production reconciliation, audit review, and rollback observation remain
    required before treating production profit as fully reconciled.

## Verification and production rollout

- [x] Unit-test receipt schemas, confidence handling, vendor learning, allocation totals, duplicate detection, daily-ad uniqueness, corrections, reimbursements, and all weekly calculations.
  - Verification: Eight focused API unit/static suites passed 80 tests and are part of the full API test command and CI workflow; two focused site suites passed 21 mobile fixed-cost, donut, and route-contract tests.
- [x] Test DST boundaries, zero revenue, zero expenses, corrected/voided entries, missing commission rows, late reimbursements, and paid-payroll double-count prevention.
  - Verification: All named edge cases passed in `expense-overview.test.ts`, `expense-overview-repository.test.ts`, `daily-ad-spend.test.ts`, `expense-managed-lifecycle.integration.test.ts`, and `expense-reimbursement-payout-transitions.integration.test.ts`.
- [x] Integration-test owner immediate posting, crew pending approval, rejection, permission isolation, reimbursement attachment, payout locking, ad correction to zero, and idempotent retries.
  - Verification: Nine mandatory PostgreSQL Expense V2 suites are wired into CI; 18 integration cases passed against a clean locally migrated PostgreSQL 16 database through migration `0108`.
- [ ] E2E-test iOS Safari/PWA and Android Chrome/PWA for camera denial, HEIC, PDF, glare, rotation, offline capture, expired sessions, reload during analysis, and storage pressure.
  - Verification: Partial—`mobile-expense-v2.spec.ts` passed 4/4 scenarios in Chromium Pixel 7 and WebKit iPhone 13 projects, covering manual/ad entry, fixed-cost coverage and History treatment, approval, fixed-cost create/revise/end, focus restoration, and the donut/list presentation. The full service-worker/camera/file/error matrix and physical-device PWA passes remain outstanding.
- [ ] Build a reviewed benchmark of at least 100 representative receipts. Require at least 98% exact total extraction and 95% date/vendor extraction before crew rollout.
  - Verification: Pending representative private corpus and live benchmark result. The repository includes a gated aggregate-only benchmark harness and runbook; no API calls or charges were made during implementation.
- [x] Confirm an extracted receipt can never post without review and exact duplicate uploads cannot create duplicate expenses.
  - Verification: Pipeline source contract, confirmation integration, dynamic SHA recheck, advisory-lock concurrency test, and database guard tests passed.
- [x] Confirm Overview reconciles exactly against fixture revenue, allocations, labor, ads, corrections, and reimbursements.
  - Verification: Exact-cent fixture assertions passed in `expense-overview.test.ts` and `expense-overview-repository.test.ts`, including zero denominators and finalized payroll replacement.
- [x] Release behind separate receipt, ad-spend, reimbursement, and Overview flags.
  - Verification: `expense-feature-flags.test.ts` passed independent default-off controls. In production, receipt API/worker, crew, ad-spend, reimbursement, Overview, and fixed-cost flags were explicitly enabled on 2026-08-27 Eastern time after the worker-first handoff.
- [x] Deploy in order: database expansion -> API -> worker -> site.
  - Verification: Render auto-deployed commit `0c2a4b8e`. The API pre-deploy
    applied and verified migration `0108` before feature activation; API deploy
    `dep-da8famht0dsc73c3b9n0`, worker deploy
    `dep-da8famht0dsc73c3bb50`, and site deploy
    `dep-da8famht0dsc73c3bcfg` all reached `live`. Receipt processing was then
    activated worker-first (`dep-da8fd3cs728c73bjnqeg`) before all API expense
    flags (`dep-da8fdt0n74is73dq464g`). Final `/api/readyz` returned HTTP 200
    with database, migration `0108`, worker heartbeat, and queue checks healthy.
- [ ] Pilot owner-only scanning with 30-50 receipts, then enable owner ad entry and Overview, then crew submission.
  - Verification: Not completed—the owner/crew audience gates remain implemented, but explicit full-production enablement was requested before the owner-only pilot and benchmark were run. Those evidence gates remain open even though crew access is live.
- [ ] Monitor analysis latency/failures, correction rate, duplicate warnings, unsynced queue age, pending approvals, missing ad days, reimbursement backlog, and incomplete overview weeks.
  - Verification: Aggregate-only operations endpoint, fresh/stale client queue telemetry, permission checks, and monitor integration tests passed. Initial post-enable readiness, queue, heartbeat, and error-log checks were healthy; sustained production observation remains pending.
- [x] Keep the existing manual expense path available as rollback; disabling flags must not hide or corrupt captured ledger data.
  - Verification: Capability/source tests confirm manual entry remains available; captured status/content paths remain readable with intake flags off, and feature-flag tests confirm independent rollback.

## Portrait, landscape, and dump-ticket addendum

This addendum extends receipt capture without adding another Spend action or
navigation destination. A person always chooses **Scan receipt**; the scanner
adapts its review to the document that was captured.

### Locked dump-ticket rules

- Portrait and landscape receipts use the same capture flow. EXIF orientation
  is normalized and the full source aspect ratio is preserved without cropping.
- Scale-ticket extraction is evidence only. A human must confirm the weight
  fields before they become operational reporting facts.
- Net weight is stored as whole pounds. Printed billed quantity is stored as
  thousandths of a US short ton, and currency remains integer cents. Reporting
  never uses binary floating-point values as accounting facts.
- A confirmed scale ticket records the facility, ticket number, material,
  gross, tare, net, billed quantity, and unit rate when each value is visible.
  Missing values remain blank; an unreadable net weight is explicitly recorded
  rather than invented.
- The review keeps net weight beside the essential receipt fields. Secondary
  scale facts stay in one collapsed details section. Ordinary receipts do not
  show dump controls.
- History shows a one-line weight summary with the existing receipt entry and
  exposes the full reviewed scale facts in its existing details disclosure.
- Weekly Overview reports dump fees, loads with confirmed weight, net tons,
  effective cost per ton, and missing-weight coverage. Missing weight never
  changes or invalidates otherwise verified profit dollars.
- Effective cost per ton uses only the Dump Fees allocation belonging to rows
  with confirmed weight. It never divides all dump spending by a partial weight
  sample.
- Immutable corrections copy reviewed dump facts to the positive replacement
  only. Reversals carry no load weight; voided and corrected originals remain
  evidence but do not count in active reporting.
- Existing historical Dump Fees are not automatically re-read or backfilled.
  They remain visible as missing weight until a later owner-reviewed workflow.

### Dump-ticket implementation checklist

- [x] Add the strict scale-ticket extraction contract, portrait/landscape
      instructions, per-field confidence, and a no-inference v1 adapter.
  - Verification: `expense-receipt-openai.test.ts` and
    `expense-receipt-domain.test.ts` passed the strict V2 structured-output
    schema for document type, facility, ticket, material, gross/tare/net pounds,
    billed thousandths of a ton, unit-rate cents, and per-field confidence. The
    prompt explicitly handles portrait, landscape, sideways, and rotated
    evidence; the legacy V1 adapter leaves absent scale facts null rather than
    deriving them.
- [x] Persist only human-confirmed dump facts in a constrained one-to-one
      expense record and preserve immutable correction/void behavior.
  - Verification: Migration `0109_expense_dump_ticket_details.sql` applied
    cleanly through all 107 migrations. Confirmation, integrity, migration, and
    PostgreSQL concurrency tests passed human-review-only persistence, positive
    Dump Fees allocation, immutable posted facts, positive-replacement copying,
    weight-free reversals, and child-write serialization against posting. Exact
    SHA-256 and normalized facility/ticket duplicates are rechecked under
    advisory locks; owner overrides require a recorded reason.
- [x] Add conditional mobile review, compact History access, owner approval
      edits, and accessible status/conversion copy without another primary action.
  - Verification: `mobile-spend-v2.test.ts` passed 27/27 assertions for compact
    review, false-positive dismissal, pending approval, dump-only History filter
    and details, receipt access, and owner Add/Correct/Remove scale-ticket facts.
    `mobile-expense-v2.spec.ts` passed 6/6 scenarios across Chromium Pixel 7 and
    WebKit iPhone 13 emulation. This is browser emulation evidence, not a claim
    of physical-device or screen-reader coverage.
- [x] Add current/prior weekly dump activity metrics with split-allocation,
      missing-weight, zero-denominator, correction, and reimbursement coverage.
  - Verification: Overview and ledger/export tests passed Dump Fees, confirmed
    ticket count, weighted ticket count, net pounds/tons, effective cost per ton,
    and missing-weight calculations for current and prior weeks. Reporting uses
    only the Dump Fees allocation of active confirmed rows, retains operational
    activity for fixed-cost-covered evidence, excludes reimbursement duplication,
    and exports reviewed scale facts through CSV.
- [x] Validate synthetic portrait, landscape, and EXIF-rotated evidence without
      committing customer receipt images or exposing receipt-level benchmark data.
  - Verification: Storage tests passed aspect-preserving normalization for
    portrait `1200x2400 -> 1024x2048`, landscape
    `2400x1200 -> 2048x1024`, and EXIF orientation 6
    `2400x1200 -> 2048x1024`. The focused backend matrix passed 149/149 tests;
    no customer image was committed and no live analysis/provider call was made.
- [x] Gate dump-ticket writes and controls for a safe rolling deployment while
      keeping previously stored reporting facts readable.
  - Verification: `EXPENSE_DUMP_TICKETS_ENABLED` defaults off and publishes the
    `dumpTickets` capability. The site hides unsupported write/filter/correction
    controls without hiding stored History or Overview facts; enabled scale
    confirmations require review contract version 2, and stale clients receive
    a non-posting HTTP 409 refresh/reopen response. Feature-flag tests passed
    8/8 and the focused API/site/E2E matrices passed with the capability enabled.
- [ ] Extend the private receipt benchmark with layout and scale-ticket cohorts;
      require at least 98% exact net-weight extraction and 100% null/no-hallucination
      behavior on non-dump negative controls before relying on automated prefills.
  - Verification: Pending a reviewed private corpus of at least 100
    representative receipts and an authorized live run. The V2 benchmark harness
    includes portrait/landscape scale-ticket and non-dump negative-control cohorts,
    but implementation verification made no provider calls or charges and does
    not establish the production accuracy thresholds.
- [ ] Deploy database -> API -> worker -> site, smoke both a normal receipt and
      a scale ticket, then monitor failures, correction rate, and missing weights.
  - Verification: Pending production deployment and production smoke evidence.

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

| Stage                       | Status                                   | Verification notes                                                                                                                                                     |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database expansion          | Production live                          | Migration `0108` applied and verified during API pre-deploy; final readiness reports `0108_expense_recurring_fixed_costs`.                                             |
| API                         | Production live; all expense flags on    | Code deploy `dep-da8famht0dsc73c3b9n0` and flag deploy `dep-da8fdt0n74is73dq464g` are live; readiness is healthy.                                                      |
| Receipt analysis worker     | Production live and enabled              | Code deploy `dep-da8famht0dsc73c3bb50` and worker-first flag deploy `dep-da8fd3cs728c73bjnqeg` are live with fresh heartbeats; the 100-receipt benchmark remains open. |
| Mobile site                 | Production live; device validation open  | Deploy `dep-da8famht0dsc73c3bcfg` is live; build, 32 site tests, and dual-browser mobile specs passed; the physical accessibility/offline matrix remains open.         |
| Owner receipt pilot         | Not completed                            | The owner-only 30–50 receipt pilot remains open. Crew access was enabled afterward only because explicit full-production enablement was requested.                     |
| Owner ad spend and Overview | Production enabled                       | Manual ad spend, Overview, and fixed-cost setup flags are live. No ad or fixed-cost values were entered during deployment.                                             |
| Crew submissions            | Enabled by explicit production direction | Crew receipt submission is live; benchmark thresholds, physical-device validation, and monitoring remain open rollout risks.                                           |

## Deferred/out of scope

- Job-level profitability.
- Formal tax filing.
- Automated accounting-platform export.
- Automatic provider-created advertising expenses.
- Automatic approval or posting from AI output.
