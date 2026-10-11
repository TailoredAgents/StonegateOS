# StonegateOS Capability Matrix

> Canonical ownership and parity map for the public site, Team Console, Mobile, and Partner Portal. Update this matrix when a capability, permission, feature flag, supported surface, or release-test owner changes.

## Evidence status

| Field                          | Value                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| Source reviewed                | 2026-10-10 at revision `c2e09ea8` plus the current Phase 1 worktree                                 |
| Fresh signed-in runtime review | Not completed; no interactive browser was connected                                                 |
| Production data changed        | No                                                                                                  |
| Interpretation                 | “Implemented” means present in current source, not automatically enabled or certified in production |

## Status legend

- **Reference**: established workflow that other surfaces should follow.
- **Strong**: broad supported implementation for that user's work.
- **Supported**: usable implementation with appropriate scope.
- **Partial**: important data or actions are missing.
- **Redirect**: the experience intentionally opens another supported surface.
- **Gated**: implementation exists but deployment configuration controls availability.
- **Not applicable**: intentionally outside that user's workflow.

## Workflow ownership and parity

| Capability                                        | Team desktop                                                                                        | Mobile                                                                                            | Public / Partner                                     | Current alignment verdict                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Public marketing and acquisition                  | Not applicable                                                                                      | Not applicable                                                                                    | **Strong** public Site                               | Keep performance and SEO separate from internal UI alignment             |
| Instant quote and booking                         | Office receives results                                                                             | Staff can inspect related records                                                                 | **Strong** public booking flow                       | Runtime and notification smoke remain required before a demo             |
| Unified Inbox                                     | **Strong** master/detail and customer workspace                                                     | **Supported** touch-focused triage and reply                                                      | Partner communication has its own workspace          | Desktop is at parity or ahead                                            |
| Contacts and properties                           | **Strong** record, property, task, job, quote, media, and intelligence views                        | **Supported** search, detail, notes, and context                                                  | Customer/partner forms create or associate records   | Desktop is ahead; mobile scope is intentionally smaller                  |
| Calendar and planning                             | **Strong** day/week/month planning, filters, conflicts, resource actions, reschedule/cancel/no-show | **Supported** day/field scheduling and quick actions                                              | Booking/Partner requests feed planning               | Desktop leads planning; mobile leads call/message/directions convenience |
| Field job execution                               | **Partial** appointment detail omits parts of scope, proof, payment, recovery, and field actions    | **Reference** scope, media, payment, completion, retry, and field tools                           | Partner job hub provides account-scoped status/proof | Highest-priority desktop parity gap                                      |
| Quotes                                            | **Strong when Quote V2 staff is enabled**                                                           | **Redirect/legacy fallback** depending on Quote V2 flag                                           | Customer Quote V2 supports proposal review/decision  | Verify all Quote V2 flags in the exact deployment before demo            |
| Spend and expenses                                | **Partial** ledger/export and approval-oriented workflow                                            | **Reference** receipt capture, scanning, offline queue, submit/review, and operational categories | Not applicable                                       | High-priority desktop gap plus permission mismatch                       |
| Owner and financial oversight                     | **Strong** revenue, payments, expenses, payroll, P&L, and assistant surfaces                        | **Supported** compact owner snapshot/tools                                                        | Partner commercial tools are separately scoped       | Desktop is ahead                                                         |
| Partner operations                                | **Strong** staff Partner workspace                                                                  | **Redirect** to Team Partner workspace                                                            | **Strong** dedicated Partner Portal                  | Functionally shared, but shell transition needs polish                   |
| Pipeline and sales operations                     | **Strong** pipeline, Sales HQ, outbound, coaching, and activity                                     | Context is distributed through Inbox/Contacts/Quotes                                              | Public acquisition supplies leads                    | Desktop-owned by design                                                  |
| Marketing, website analytics, and SEO             | **Strong** office/owner surfaces                                                                    | Not applicable                                                                                    | Public Site emits acquisition data                   | Desktop-owned by design                                                  |
| Policy, automation, commissions, audit, and merge | **Strong** permission-gated administration                                                          | Mostly not applicable                                                                             | Not applicable                                       | Desktop-owned by design                                                  |
| Access and personal settings                      | **Strong** member, role, session, and personal controls                                             | **Supported** owner access readiness and personal settings                                        | Partner account settings are separate                | Shared identity rules; desktop owns deep administration                  |

## Important permission ownership

| Domain   | Team surface gate                      | Mobile screen gate                                          | Alignment note                                                             |
| -------- | -------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Calendar | `appointments.read`                    | `appointments.read` or booking management as applicable     | Job-level write actions require their own API permissions                  |
| Inbox    | `messages.read`                        | `messages.read` or `messages.send`                          | Sending remains server-authorized                                          |
| Contacts | `contacts.read`                        | Booking-management access currently exposes mobile Contacts | Reconcile naming and least-privilege intent during desktop foundation work |
| Quotes   | `quotes.read`                          | Any supported quote read/write/send/update grant            | Quote V2 enablement is separate from permission visibility                 |
| Expenses | `expenses.read`                        | `expenses.submit` or `expenses.approve`                     | Current mismatch can hide desktop Expenses from legitimate crew submitters |
| Partners | Any registered Partner read permission | Uses the Team Partner surface gate                          | Mobile intentionally redirects to the Team workspace                       |
| Owner    | `finance.read`                         | Owner role or wildcard permission                           | Mobile is a compact operational view, not a full finance replacement       |
| Access   | `access.manage`                        | Owner-only screen logic                                     | API enforcement remains mandatory                                          |

## Major deployment gates

| Capability               | Representative configuration                   | Default/source posture                   | Required evidence before showing                                                   |
| ------------------------ | ---------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Quote V2 staff workspace | `QUOTE_V2_STAFF_ENABLED`                       | Fail-closed in production unless enabled | Create, edit, send, customer decision, and booking handoff                         |
| Quote V2 customer flow   | Public/mutation/sender/booking flags           | Staged rollout flags                     | Token safety, proposal rendering, decision, idempotency, and notification evidence |
| Appointment media        | Media write/upload flags                       | Operationally gated                      | Upload, proof visibility, authorization, storage, and recovery                     |
| Mobile offline media     | `MOBILE_OFFLINE_MEDIA_ENABLED`                 | Operationally gated                      | Offline queue, reconnect, retry, and duplicate prevention                          |
| Mobile booking cards     | `MOBILE_BOOKING_CARDS_V2_ENABLED`              | Flag-controlled                          | Jeffrey-approved phone baselines and real-device flow                              |
| Mobile Square payments   | `MOBILE_SQUARE_PAYMENTS_ENABLED`               | Explicit enable required                 | Controlled sandbox/test payment and no real-customer charge path                   |
| AI-assisted actions      | Provider credentials, quotas, and policy gates | Provider-dependent                       | Quota, privacy, approval, fallback, and no-uncontrolled-send checks                |

Do not record secret values in this matrix. Record only enabled/disabled state and the evidence source in a dated release audit.

## Test and release ownership

| Evidence lane                              | Primary responsibility                                           | Current Phase 1 status                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| API Jest suite                             | Domain, permission, source-contract, and API behavior            | Green locally and in a clean Node 20 container: 469 suites and 4,739 tests passed; 67 suites and 330 tests skipped by design |
| Default Playwright                         | Public, lead, quote, mobile, and smoke journeys                  | Present in general workflow                                                                                                  |
| Quote V2 visual Playwright                 | Staff/customer proposal rendering                                | Present in general workflow                                                                                                  |
| Partner Portal Playwright/release workflow | Partner account and staff journeys                               | Dedicated release evidence exists                                                                                            |
| Team Console audit                         | Role, viewport, theme, accessibility, and critical Team journeys | Wired into the general workflow; TypeScript contract passes, while authenticated browser execution remains open              |
| Generated-doc check                        | Route, schema, and literal outbox drift                          | Added in Phase 1                                                                                                             |
| Signed-in live smoke                       | Exact deployed Team/Mobile behavior                              | Open; requires a connected authenticated browser or controlled operator evidence                                             |

## Protected intentional differences

- Mobile navigation and field workflows may remain purpose-built and touch-focused.
- Desktop may expose denser tables, cross-record context, deep administration, and reporting that do not belong on a phone.
- Mobile offline queues are not automatically required on desktop.
- Desktop and mobile must still agree on permissions, statuses, totals, job truth, and customer-facing outcomes.

## Highest-priority parity defects

1. Desktop appointment detail lacks the complete mobile field-job context and actions.
2. Desktop Expenses does not provide Mobile Spend V2 capability or equivalent crew-submit access.
3. Mobile-to-Team redirects for Quotes/Partners can feel like a product switch.
4. Labels and visual language differ across the two shells.
5. Desktop visual and responsive assurance remains incomplete until authenticated Team baselines are captured at the agreed viewports.

## Completion rule

A row moves from Partial or Gated to Supported/Strong only when source, permission, automated-test, required runtime, and deployment-flag evidence agree. Source review alone cannot certify live provider or protected-route behavior.
