# Full `/team` CRM audit

Date: 2026-08-05
Code reviewed: `main` at `116339d`
Product readiness verdict: **Blocked**
Audit execution status: **Static/code audit complete; runtime, provider, performance, visual, and staff validation incomplete**

## Executive summary

The current `/team` CRM should not be released as a product-grade multi-role console. Three statically confirmed P0 authorization defects invalidate the trust boundary before visual polish or workflow scoring can be considered a release verdict:

1. Any nonempty legacy owner/crew cookie is treated as authenticated. An arbitrary owner cookie reaches the server helper that adds the real `ADMIN_API_KEY` and an owner actor role.
2. Several public same-origin `/api/team/**` proxies have no session guard, yet they call the privileged helper. The shell-less `/team/instant-quotes/[id]` page has no auth guard, fetches the latest 25 quotes, and renders an unauthenticated delete action backed by a key-only API.
3. Supported `sales`, `read_only`, and custom roles are rejected by the page but coerced to `office` at local proxy gates. The original principal is forwarded upstream, but core contact APIs rely on the internal key rather than granular end-user permissions, allowing direct low-privilege mutations.

The audit records 25 findings: **3 P0, 6 P1, 14 P2, and 2 P3**. Additional critical workflow risks include team sessions that cannot execute legacy-only Commissions and Contacts actions, false success messages after failed mutations, destructive merge/delete operations without impact previews, and same-address/property integrity faults. Important P2s include the orphaned circular instant-quote booking CTA, broken login/setup handoffs, and missing last-owner invariants. The dormant legacy attachment path is P3 and outside active canonical `/team` behavior.

The provisional tab score is **3.46/5 (69/100)**. That score describes source-visible functional/UX breadth, not release readiness; the global P0 gate overrides it. Contacts, Quotes, Calendar, and Commissions show strong product value, but their accessibility/role-access scores now reflect the confirmed permission model failures. Inbox, Automation, Sales HQ, Owner HQ, Outbound, and Access are powerful but structurally dense. Audit Log and the standalone instant-quote surface are materially incomplete for their stated jobs.

No product behavior was changed. The implementation adds an audit-only Playwright configuration and fixtures, machine-readable findings/coverage/scorecards, a staff-session script, and this remediation roadmap.

## What was and was not executed

### Executed

- Canonical inventory of 23 tabs, tab groups, permission requirements, render gates, aliases, auth routes, classic layout, and `/team/instant-quotes/[id]`.
- Source-backed subview/action/proxy/endpoint/entity inventory, a 23-tab role-access matrix, and a sensitive-action authorization/attribution matrix.
- Independent static tracing of the page → same-origin proxy/server action → `callAdminApi` → API permission chain.
- Source-level review of every canonical tab and the requested cross-tab overlaps.
- Typecheck, production build, raw lint, lint ratchet, API/unit tests, configured Playwright discovery, and audit-suite discovery.
- Static accessibility, responsive, error-state, request-topology, privacy, documentation, and regression-gap review.

### Not executed

- Browser journeys, screenshots, videos, network/console captures, database before/after assertions, provider-mock assertions, visual comparison sheets, automated WCAG scans, screen-reader testing, or mutation replay.
- Core Web Vitals and performance traces.
- Five staff think-aloud sessions.

The reason is environmental, not a pass: Docker is not installed; PostgreSQL, Site, and API are not running; E2E seed/cleanup receive `ECONNREFUSED`; Chrome DevTools MCP is unavailable; no sanitized staging clone/provider sandbox or staff participants were supplied. Zero Playwright browser cases executed. See `artifacts/team-crm-audit/evidence-index.md`.

## Baseline

| Check                              | Result                                    | Evidence                                                                                                              |
| ---------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Typecheck                          | Pass in 13.95s                            | API and Site passed; Contentlayer emitted a non-fatal Node 24 compatibility warning.                                  |
| Configured production build        | Infrastructure fail                       | Turbo could not find a bare `pnpm` binary on PATH.                                                                    |
| Build with temporary Corepack shim | Pass in 17.92s outside restricted sandbox | 6/6 Turbo tasks; 80 Site pages, 134 API pages. `/team`: 84.2 kB route, 231 kB first-load JS.                          |
| Raw lint                           | Fail                                      | 991 errors total. Site: 424 errors/12 warnings. API: 567 errors. `/team`: 126 errors/6 warnings.                      |
| Lint ratchet                       | Pass                                      | 991 is below the accepted baseline of 1027.                                                                           |
| API/unit tests                     | Pass outside restricted sandbox           | 40 suites passed, 1 skipped; 243 tests passed, 1 skipped.                                                             |
| Existing Playwright discovery      | Pass                                      | 115 configured cases in 10 files.                                                                                     |
| Existing Playwright execution      | Blocked; zero tests ran                   | Docker absent and E2E database/services unavailable.                                                                  |
| Audit harness typecheck            | Pass                                      | Dedicated config, setup/teardown, fixtures, and audit spec compile without emitting files.                            |
| Audit database safety sentinel     | Pass                                      | Accepted the exact `.env.e2e` target; a deliberate mismatch stopped before any connection or seed.                    |
| Audit Playwright discovery         | Pass                                      | 590 project-expanded cases in one source file across 10 viewport/theme projects; includes skipped/fixme placeholders. |
| Chrome performance tooling         | Unavailable                               | Chrome DevTools MCP is not configured.                                                                                |

The raw lint failures matter even though the ratchet passes: `/team` currently includes conditional hooks, floating/misused promises, unsafe values, raw image handling, unused code, and unstable hook dependencies. These are not all user-facing defects, but they reduce audit confidence and make failure handling harder to reason about.

The canonical inventory is normalized across three machine-readable artifacts: `surface-inventory.csv` covers 33 canonical/auxiliary/alias/compatibility surfaces and their subviews, actions, proxies, upstream endpoints, entities, and source evidence; `role-tab-access-matrix.csv` covers all 23 tabs against owner, office, sales, crew, read-only, and custom grant/deny expectations versus actual source behavior; `sensitive-action-matrix.csv` traces 35 high-risk or explicitly read-only action rows across all 23 tabs plus authentication and compatibility surfaces. Runtime outcomes remain in `coverage-matrix.csv` and are not inferred from these static matrices.

## Release gate findings

### TEAM-AUTH-001 — P0: arbitrary legacy cookie becomes owner

`apps/site/src/app/team/page.tsx:145-158` treats any nonempty `myst-admin-session` as owner. `apps/site/src/app/api/team/auth.ts:18-20` and selected owner routes repeat the presence check. `apps/site/src/app/team/lib/api.ts:69-85,114-147` turns that cookie into `x-actor-role: owner` while injecting the genuine server `ADMIN_API_KEY`; `apps/api/src/lib/permissions.ts:140-143` grants owner `*`.

Safe runtime reproduction after services exist:

```text
Cookie: myst-admin-session=definitely-not-the-admin-key
GET /team?tab=access
```

Expected: redirect/401 before upstream access. Current source path: owner UI and owner-credentialed upstream calls. This is a stop-ship authentication bypass.

### TEAM-AUTHZ-002 — P0: public proxies can wield the admin key

Media analysis, quote photos, sales-agent memory, next-action control, and Inbox suggestion proxies do not call the team-session guard. They call `callAdminApi`, which injects the privileged key. The auxiliary instant-quote page likewise has no auth boundary: it fetches customer details and the latest 25, then renders `deleteInstantQuoteAction`, whose upstream DELETE is key-only. Key-only routes accept this chain unconditionally. Permission-gated routes additionally return `enforce: false` and `permissions: ["*"]` when both actor role and ID are absent; an environment-provided default actor can alter that second path. The route also inherits the root layout's index/follow default rather than `/team` page metadata.

Anonymous requests must return 401 before parameter validation and must not call upstream. The rendered instant-quote delete is a statically complete anonymous action path; other unguarded action references still require deployed action-ID/origin replay. Authenticated product metadata must apply noindex/nofollow from a shared `/team` layout.

### TEAM-AUTHZ-003 — P0: role rejection and coercion break least privilege

The page authenticates only `owner`, `office`, and `crew`, even though `sales`, `read_only`, and arbitrary custom roles exist. The site route helper maps any valid non-owner/non-crew role to `office` for its local gate; `callAdminApi` separately forwards the original role/member. Core Contacts, Properties, Pipeline, and Task routes contain key-only paths without granular permission enforcement, so a direct low-privilege request can still perform unauthorized CRM mutations.

Effective permissions must be the sole end-user source of truth. Role slugs may seed permissions but must never replace them, and unknown/custom roles must never be promoted.

### Critical P1s

| ID             | Outcome                                                                                                                                             | Evidence                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| TEAM-AUTHZ-004 | Valid team-owner sessions see Commissions but selected routes accept only a legacy cookie; team users can create notes but cannot edit/delete them. | `apps/site/src/app/api/team/commissions/**`; `contacts/notes/[noteId]/route.ts` |
| TEAM-AUTHZ-005 | Nav permissions, JSX role render gates, and API permissions disagree, creating blank or nonfunctional tabs.                                         | `page.tsx:413-531,767-917`                                                      |
| TEAM-REL-006   | Appointment status/notes and quote decisions can show success after a non-2xx upstream response.                                                    | `actions.ts:97-129,204-222,476-493`                                             |
| TEAM-DATA-008  | Merge approval has no impact preview/confirmation; contact/property cascades lack recovery expectations.                                            | `MergeQueueSection.tsx:120-173`; schema cascade relationships                   |
| TEAM-DATA-009  | Property uniqueness is global across customers; conflicts are mislabeled and partial edits geocode incomplete addresses.                            | schema `:335-340`; contact/property routes                                      |
| TEAM-SEC-011   | Login abuse controls are absent in application code; normalized email is not unique; magic-link consumption is non-atomic.                          | public login routes; `team-auth.ts`; team member/token schema                   |

Full reproduction, expected/actual behavior, impact, likely cause, effort, confidence, and acceptance criteria are in `artifacts/team-crm-audit/findings.json`.

## Score model and interpretation

Scores use the requested weights:

| Dimension                                  | Weight |
| ------------------------------------------ | -----: |
| Functionality and data integrity           |    25% |
| Utility and task completeness              |    15% |
| Ease and workflow efficiency               |    15% |
| Simplicity and information architecture    |    10% |
| Visual design and consistency              |    10% |
| Accessibility and role-based access        |    15% |
| Performance, resilience, and observability |    10% |

All tab scores are provisional source-review scores. Runtime failures must reduce them during replay. P0 inheritance is recorded as a blocker rather than subtracting the same global defect from every row.

## Tab-by-tab scorecards

| Tab                  |   F |   U |   E |   S |   V |   A |   P | Weighted | Decision               | Principal audit focus                                                                                                     |
| -------------------- | --: | --: | --: | --: | --: | --: | --: | -------: | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Calendar             |   4 |   5 |   5 |   4 |   4 |   2 |   3 |     3.90 | Keep                   | DST/conflicts, external-event limits, final totals, crew attribution, concurrency, mobile grid/detail.                    |
| Inbox                |   5 |   5 |   3 |   1 |   4 |   2 |   2 |     3.45 | Simplify               | Queues/counts, pagination, silent ancillary failures, 8s polling, media fan-out, stale selection, multi-workflow density. |
| Contacts             |   5 |   5 |   5 |   2 |   4 |   2 |   3 |     3.95 | Simplify               | Identity normalization, shared addresses, properties/cascades, notes/tasks semantics, AI state, destructive impact.       |
| Quotes               |   5 |   5 |   4 |   2 |   4 |   2 |   3 |     3.80 | Simplify               | Price/lifecycle integrity, false success, send/delete permissions, Create/Manage hierarchy, booking handoff.              |
| Expenses             |   3 |   4 |   4 |   4 |   4 |   4 |   4 |     3.75 | Keep                   | Money/date/upload validation, correction path, totals reconciliation, authorization.                                      |
| Pipeline             |   4 |   5 |   4 |   3 |   4 |   2 |   3 |     3.65 | Keep                   | Unbounded data, wide board, drag/keyboard parity, optimistic rollback, cross-tab consistency.                             |
| Sales HQ             |   5 |   5 |   3 |   1 |   4 |   2 |   3 |     3.55 | Simplify               | Metric math/terminology, queue ownership, draft staleness, clear next actions, coaching controls.                         |
| Simulated Chat       |   4 |   3 |   3 |   3 |   4 |   2 |   4 |     3.30 | Move to Advanced       | Prove no real sends/mutations, contact-context privacy, local storage bounds, error/mode clarity.                         |
| Outbound             |   5 |   5 |   3 |   2 |   4 |   2 |   3 |     3.65 | Simplify               | Import boundaries/partial failures, DNC/callback scheduling, bulk idempotency, dense detail.                              |
| Partners             |   4 |   4 |   3 |   3 |   4 |   4 |   2 |     3.55 | Combine with Outbound  | Failed-versus-empty states, invitation/rate precedence, portal consequences, mobile tables.                               |
| Owner HQ             |   5 |   5 |   4 |   2 |   4 |   3 |   3 |     3.95 | Simplify               | Source-of-truth reconciliation, inactive-view fetching, Square/refund states, assistant authorization.                    |
| Google Ads           |   5 |   4 |   3 |   2 |   4 |   1 |   4 |     3.45 | Combine into Marketing | Apply/bulk idempotency, explicit confirmation, provider states, audit history.                                            |
| Website Analytics    |   4 |   4 |   3 |   3 |   4 |   1 |   3 |     3.20 | Combine into Marketing | Partial completeness, metric definitions, delayed/zero data, identifier leakage.                                          |
| SEO Agent            |   3 |   3 |   3 |   4 |   4 |   1 |   4 |     3.00 | Combine into Marketing | Duplicate runs, publication boundaries, eligibility/timezones/provider failure.                                           |
| Policy Center        |   5 |   5 |   3 |   2 |   4 |   1 |   4 |     3.60 | Advanced               | Fourteen editor isolation, JSON round trips, concurrency/versioning, cross-tab effects.                                   |
| Messaging Automation |   5 |   5 |   2 |   1 |   3 |   1 |   4 |     3.25 | Advanced + simplify    | Policy precedence, legacy/new mode duplication, raw IDs, DNC/takeover safeguards.                                         |
| Commissions          |   5 |   5 |   3 |   3 |   4 |   1 |   4 |     3.70 | Advanced               | Team-session failure, math/timezone, lock/pay idempotency, immutable state, receipts/attribution.                         |
| Access               |   5 |   5 |   2 |   2 |   3 |   1 |   3 |     3.25 | Advanced               | Free-form permissions, deny wins, normalized identity, self/last-owner invariants, revocation.                            |
| Sales Log            |   4 |   4 |   3 |   2 |   4 |   1 |   3 |     3.10 | Combine with Sales HQ  | Metric overlap, feed ownership, volume/filtering, attribution.                                                            |
| Audit Log            |   2 |   3 |   2 |   5 |   3 |   1 |   3 |     2.50 | Advanced               | Latest 50 only; missing filters, pagination, correlation, safe export, completeness verification.                         |
| Merge Queue          |   4 |   4 |   2 |   4 |   3 |   1 |   3 |     3.05 | Advanced               | Raw UUID workflow, preview/confirmation/recovery, simultaneous reviewers, consolidation rules.                            |
| Agent                |   4 |   4 |   4 |   2 |   3 |   2 |   3 |     3.30 | Move to Advanced       | Approval boundary, parameter visibility, prompt injection, permission denial, duplicate/undo.                             |
| Settings             |   4 |   4 |   5 |   3 |   3 |   2 |   4 |     3.65 | Simplify               | Split personal settings from owner diagnostics/export/emergency access.                                                   |

Legend: F functionality/data integrity, U utility, E ease, S simplicity, V visual consistency, A accessibility/role access, P performance/resilience/observability.

### Auxiliary surfaces

| Surface                   |   F |   U |   E |   S |   V |   A |   P | Weighted | Decision                          | Key issue                                                                               |
| ------------------------- | --: | --: | --: | --: | --: | --: | --: | -------: | --------------------------------- | --------------------------------------------------------------------------------------- |
| Login page                |   4 |   4 |   4 |   5 |   4 |   3 |   4 |     3.95 | Keep + harden                     | Cookie presence is mistaken for a valid session; runtime abuse controls are unverified. |
| Magic-link callback       |   2 |   3 |   2 |   4 |   3 |   2 |   3 |     2.55 | Keep + harden                     | Token consumption is non-atomic and password setup lands on the wrong tab.              |
| Modern shell              |   3 |   4 |   3 |   3 |   4 |   2 |   3 |     3.10 | Keep + fix                        | Role-filtered navigation/render gates disagree; dialog and heading semantics are weak.  |
| Legacy aliases            |   3 |   2 |   2 |   1 |   3 |   2 |   3 |     2.35 | Deprecate after telemetry         | Silent remapping, ignored quoteMode, stale mental models, and unmounted components.     |
| Instant Quote + latest 25 |   2 |   2 |   1 |   2 |   3 |   1 |   2 |     1.80 | Combine into Quotes               | Orphaned, outside the shell, publicly exposes PII/delete, and its booking CTA loops.    |
| Classic layout            |   3 |   3 |   3 |   2 |   3 |   2 |   3 |     2.75 | Deprecate after parity/usage gate | Duplicated IA/permissions enlarge the matrix; the modern switch is currently a no-op.   |

Dimension-level auxiliary inputs are also machine-readable in `artifacts/team-crm-audit/auxiliary-scorecards.csv`.

## Cross-tab journeys

All seven journeys are **not run**, not failed or passed. The test suite contains explicit `fixme` entries so the missing implementations stay visible.

| Journey                      | Static risk to resolve before replay                                                      | Runtime prerequisite                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Lead to booked job           | Proxy authorization, false success, Inbox pagination/state, quote handoff                 | Seeded messages/contacts/quotes/appointments and provider fakes |
| Day of service               | Crew/quote permission mismatch, completion feedback, payment/payout integrity             | Calendar fixtures, Square sandbox, DB/audit checks              |
| Lead recovery                | Sales role rejected/coerced; Sales HQ/Inbox overlap                                       | Valid sales role and call/message fakes                         |
| Outbound partner acquisition | Role enforcement, bulk/import idempotency, partner failure-to-empty                       | Dense import fixtures and sandbox messaging/portal              |
| Money close                  | Legacy-only Commissions actions and destructive/money safety                              | Payment/refund/expense/payout fixtures and Square mock          |
| Automation safety            | Unguarded proxies, owner-only render mismatch, weak audit investigation                   | AI/Meta/Twilio fakes and audit assertions                       |
| Administration               | Forged-cookie bypass, custom-role rejection/coercion, setup handoff, last-owner invariant | Multi-session role fixtures and revocation assertions           |

## Accessibility and visual quality

Static review found concrete WCAG risks:

- Mobile drawer has `role=dialog`/`aria-modal` but no focus trap, initial focus, Escape behavior, or focus restoration.
- Desktop collapse state is reused inside the mobile drawer; icon-only collapsed controls are inconsistently named.
- The modern shell title is not an `h1`; most tab pages begin with `h2`.
- Flash messages lack live-region semantics. Skeletons lack busy/status semantics and reduced-motion treatment.
- Several searches rely on placeholder text rather than a persistent programmatic label.
- Dark mode relies on a broad CSS override shim for raw Tailwind utility colors, increasing state/contrast drift risk.
- Pipeline's desktop composition specifies a minimum 720px board plus a 420px detail column; dense tables/cards still need 320/375/768 overflow proof.

No automated axe, contrast, zoom, reduced-motion, keyboard journey, or screen-reader pass ran. The acceptance bar remains WCAG 2.2 AA, zero unexplained serious/critical automated violations, and keyboard completion of every critical journey.

## Performance, resilience, and observability

The production build reports 231 kB first-load JS for `/team`, but route size is not a user timing. Static request topology identifies these first trace targets:

- Inbox: five initial parallel calls, then contact timeline/summary/task/next-action work; 8-second polling; per-attachment `HEAD` checks; partial failures often become null.
- Pipeline: unbounded board load and wide DOM/layout pressure.
- Contacts: team directory, list, and selected-record sequencing; property-search materialization in the API.
- Owner HQ: revenue, expenses, commissions/payroll, and booking source load regardless of most subviews; Payments adds reconciliation plus up to 200 appointments.
- Marketing/analytics: multiple provider endpoints and ambiguous partial completeness.

The requested targets remain LCP ≤2.5s, INP ≤200ms, CLS ≤0.1, TTFB ≤800ms, and visible feedback within 100ms. No metric is claimed because Chrome DevTools MCP and a live app are absent. Five-run desktop and Fast/Slow 4G traces must be attached before performance completion.

Observability is also incomplete: authenticated product telemetry is not evident, while Google tags are mounted in the root layout shared by `/team`. A runtime network capture must prove internal route/customer identifiers are excluded from marketing providers.

## Simplicity and recommended information architecture

Pending staff validation, the simplest durable structure is:

- Five primary anchors: Calendar, Inbox, Contacts, Quotes, Expenses.
- Sales: Pipeline, Sales HQ, Outbound. Make Partners an Outbound lifecycle subview and Sales Log an Activity subview of Sales HQ.
- One Marketing destination with Ads, Website Analytics, and SEO subviews.
- Owner HQ as the financial overview, with contextual links to Expenses and an Advanced Commissions workspace rather than duplicated controls.
- Admin/Advanced: Policy, Automation, Commissions, Access, Audit, Merge.
- Advanced Tools: Agent and Simulated Chat, with an unmistakable simulation/approval boundary.
- Settings: personal account/session preferences only; move emergency access, exports, and calendar diagnostics to Access/Diagnostics.
- Consolidate Instant Quotes into Quotes, then retire the shell-less route after handoff and usage checks.
- Keep classic and aliases only behind telemetry-backed deprecation criteria.

Utility conclusions are hypotheses until one owner, two office/sales, and two crew participants complete the prepared sessions in `artifacts/team-crm-audit/staff-session-guide.md`.

## Remediation roadmap

### Now — release gate

1. Replace all presence-only legacy cookie checks with one centralized verified principal; revoke or strictly validate break-glass cookies.
2. Guard every `/api/team/**` route and server action before parsing/calling upstream; make API permissions fail closed; use explicit service principals for workers.
3. Preserve exact role/effective grants and denies across page, proxy, and API. Add explicit Contacts/Properties/Pipeline/Tasks read/write permissions.
4. Align navigation visibility, content rendering, direct URL behavior, and API enforcement from one permission contract.
5. Make valid team sessions work across Commissions and note edit/delete; remove legacy-only workflow dependencies.
6. Eliminate false-success mutations and add duplicate/idempotency/conflict tests.
7. Add impact previews, confirmations, concurrency controls, audit evidence, and recovery for merges/deletes.
8. Restore an isolated E2E stack and promote forged-cookie, anonymous-proxy, role-matrix, and all-tab owner smoke into blocking CI.

### Next — reliability and task completion

1. Fix instant-quote booking handoff, Inbox pagination, per-lead dismissal, property address/geocode integrity, and failed-versus-empty states.
2. Implement database/provider/audit assertions for the seven critical journeys and every sensitive mutation.
3. Add a shared accessible CRM layer for page headers, forms, tables/cards, dialogs/drawers, alerts, loaders, destructive confirmations, and action feedback.
4. Add throttling, normalized unique login identity, atomic token replay protection, session revocation, self-deactivation/last-owner safeguards.
5. Define and verify a complete, immutable, filterable Audit Log contract.
6. Capture five-run performance traces and address measured Inbox/Pipeline/Contacts/Owner hot paths.

### Later — simplification and polish

1. Run the five staff sessions and re-score utility/ease/simplicity.
2. Consolidate Sales and Marketing overlaps; move advanced tools/admin surfaces; split Settings by ownership.
3. Instrument privacy-safe usage for aliases/classic, set retirement triggers, remove unreachable legacy components, and update operator docs.
4. Establish visual baselines for all 23 tabs at 320/375/768/1024/1440 in both themes and a classic smoke sheet.
5. Replace broad dark-mode override debt with proven design primitives and finish lint burn-down.

## Audit suite and replay protocol

The separate suite is intentionally not part of the default `playwright.config.ts`:

- `playwright.team-audit.config.ts`
- `tests/e2e/audit/global-setup.ts`
- `tests/e2e/audit/global-teardown.ts`
- `tests/e2e/audit/db-safety.ts`
- `tests/e2e/audit/preflight.ts`
- `tests/e2e/audit/team-console-audit.spec.ts`
- expanded audit fixture support in `tests/e2e/support/team-auth.ts`

It declares light/dark projects at 320, 375, 768, 1024, and 1440; owner all-tab smoke/screenshots; anonymous/forged/inactive/expired session probes; office/sales/crew/read-only/custom role cases; anonymous instant-quote/proxy probes; aliases/invalid tab/classic checks; and shell keyboard semantics. Seven mutation-heavy journeys are explicit `fixme` work, because implementing them without provider fakes and database verification would create false confidence.

The audit setup is intentionally destructive only to a disposable E2E database. Before its seed runs, it requires the active `DATABASE_URL` to exactly match `.env.e2e`; non-loopback targets additionally require `TEAM_AUDIT_REMOTE_DESTRUCTIVE_ACK=I_UNDERSTAND_THIS_DELETES_CRM_DATA`. Standard role rows are never overwritten, and audit identities, sessions, the custom audit role, and storage-state files are removed after success or partial setup failure and again in audit-specific teardown.

Once prerequisites exist:

```bash
corepack pnpm dev:e2e:team-audit
corepack pnpm test:e2e:team-audit
```

Run those in separate terminals only after checking that `.env.e2e` identifies the disposable clone. The audit-specific dev wrapper performs the same sentinel check before the existing `dev:e2e` seed; do not bypass it or set the remote acknowledgement for production or a shared staging database.

For each mutation, snapshot the database first, then assert the changed record, linked entities, provider fake, actor attribution, audit event, user feedback, duplicate submission, retry, and concurrency behavior. Replay every P0/P1 after remediation before changing the readiness verdict.

## Completion assessment

The repository/accounting portion is complete: all 23 tabs, login/auth, modern shell, aliases, classic path, and instant-quote auxiliary route are inventoried and statically scored; the role/access and sensitive-action matrices are source-backed; findings are evidenced and paired with acceptance criteria; a Now/Next/Later backlog and regression harness exist.

The full audit is **not complete** under the requested completion criteria. It still requires:

- Runtime coverage for every relevant role, viewport, theme, state, and direct/mutating/export path.
- Database/provider/attribution/audit verification for every sensitive mutation.
- Reproducible results for all seven journeys.
- Automated/manual accessibility and performance evidence.
- Five staff utility sessions.
- Runtime replay of every P0/P1.

This distinction is intentional: **product readiness is Blocked, and audit completion is also blocked on the missing execution environment and participants.**

## Deliverable index

- Report: `docs/audits/team-crm-audit.md`
- Baseline: `artifacts/team-crm-audit/baseline-results.json`
- Findings: `artifacts/team-crm-audit/findings.json`
- Coverage: `artifacts/team-crm-audit/coverage-matrix.csv`
- Routes: `artifacts/team-crm-audit/route-inventory.csv`
- Full surface/action/endpoint/entity inventory: `artifacts/team-crm-audit/surface-inventory.csv`
- Role × tab access matrix: `artifacts/team-crm-audit/role-tab-access-matrix.csv`
- Sensitive-action authorization matrix: `artifacts/team-crm-audit/sensitive-action-matrix.csv`
- Tab scorecards: `artifacts/team-crm-audit/tab-scorecards.csv`
- Auxiliary scorecards: `artifacts/team-crm-audit/auxiliary-scorecards.csv`
- Journeys: `artifacts/team-crm-audit/journey-results.csv`
- Staff script: `artifacts/team-crm-audit/staff-session-guide.md`
- Evidence index: `artifacts/team-crm-audit/evidence-index.md`
- Proposed audit suite: `playwright.team-audit.config.ts` and `tests/e2e/audit/`
