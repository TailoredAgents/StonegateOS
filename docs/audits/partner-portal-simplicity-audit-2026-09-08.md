# Partner portal: relationship-first simplicity and functionality audit

Date: September 8, 2026. Code baseline: `a70006eee418ce03534b3386e38717d0440de0ef`.

## Approved implementation ledger

The owner approved the relationship-first remediation plan on September 8, 2026. The core implementation and local verification milestone is complete; explicit residual workflow limits and release gates remain open below. The original observations remain historical evidence, not claims about the updated worktree. No production cutover, provider certification, accessibility certification, or user-success result is implied by a source change or passing unit test.

Superseding decisions: public acquisition/applications are retired in favor of staff-approved relationships and invitations; no MFA is restored; CRM-owned invoices and embedded Square payment collection replace Square-managed invoices; optional advanced tools remain in scope and require full verification; recurrence supports an end date or ongoing service; release uses internal Stonegate validation and one external cutover, not selected-partner canaries. Help is sales@stonegatejunkremoval.com / 404-777-2631.

| Finding | Resolution status | Implementation | Automated evidence | Manual evidence | Operational evidence |
| --- | --- | --- | --- | --- | --- |
| LIVE-01 | Release gate open | Compact login/contact-only access; purpose-auth and V2 flags remain off by default | B public rendering; S public route policy | M0 | O0 |
| LIVE-02 | Operational setup required | Staff relationship setup, explicit company approval, invitation and workflow configuration | P invitation/access tests; production state not re-queried | M0 | O0 |
| LIVE-03 | Implemented; configuration and certification open | Shared weighted inspector and bounded legacy-read snapshot; named crew/equipment configuration and CRM/review selection; service_request fallback and durable calendar blocks | P named-resource races/review acceptance; R CRM selection/retry; calendar/provider certification still required | M0 | O0 |
| DESIGN-01 | Implemented; release verification open | (public)/page.tsx; PartnerPasswordLoginForm | B: 3 engines × 5 widths | M0 | O0 |
| DESIGN-02 | Implemented; release verification open | partner-access-retirement; PartnerAccessHelp; relationship invitation flow | P invitation tests; S retired route tests | M0 | O0 |
| DESIGN-03 | Implemented; release verification open | Shared direct login form on /partners and /partners/login | B: 60 public Axe scans, no overflow | M0 | O0 |
| DESIGN-04 | Implemented; release verification open | partners/layout metadata, sitemap removal, neutral social preview | S indexability checks; B noindex HTML | M0 | O0 |
| DESIGN-05 | Implemented; release verification open | PartnerAppShell; workflow-controlled tools; personal/company settings; tools history; opaque mobile navigation for consistent contrast | S navigation; B real four-role login/Home, denied portfolio access and explicit company switching after suspension | M0 | O0 |
| DESIGN-06 | Implemented; release verification open | overview API and job-first Home; scoped billing and notifications | P notice scope; B four-role Home and operational-only financial exclusion | M0 | O0 |
| DESIGN-07 | Implemented; release verification open | book/page.tsx optional tools below the four-part request; no setup gate | R actual booking component | M0 | O0 |
| DESIGN-08 | Implemented; release verification open | PartnerBookingWizard four parts with optional sections | R draft switching/Back recovery; timed usability not performed | M0 | O0 |
| DESIGN-09 | Implemented; release verification open | Personal/company settings separation; simple proof downloads; CRM billing controls | P proof/financial workers; manual full-layout review outstanding | M0 | O0 |
| DESIGN-10 | Implemented; release verification open | PartnerAccessHelp; public contact page; shared errors and unavailable sessions | B Sales email/phone destinations | M0 | O0 |
| ACCESS-01 | Implemented; release verification open | Native POST credential forms; tokenless same-origin referrer policy; validated actual Site origin; strict CSRF unchanged | B rebuilt JavaScript-disabled sign-in POST passes; real four-role native login passes; S trusted-origin tests | M0 | O0 |
| ACCESS-02 | Retired with compatibility; release verification open | Historical application status is read-only; no new public applications | S workflow_retired/status tests | M0 | O0 |
| ACCESS-03 | Retired with compatibility; release verification open | Historical statuses explicit; old applicant cookie cannot redirect root; outstanding activation retained | S compatibility tests; token-link production smoke outstanding | M0 | O0 |
| ACCESS-04 | Retired with compatibility; release verification open | Application mutations return workflow_retired and Sales help; history retained | S API retirement tests | M0 | O0 |
| ACCESS-05 | Implemented; release verification open | Private unavailable-session response retains session and provides recovery/help | S asynchronous cookie matrix; B stale-cookie tests | M0 | O0 |
| ACCESS-06 | Implemented; release verification open | Public header policy, help route, historical application page | S route/header tests | M0 | O0 |
| ACCESS-07 | Implemented; release verification open | Explicit invitation role and relational scope choices; revalidation on accept; suspended selected-company access fails closed instead of silently using another company | R actual invitation component; P invitation authorization; B all four roles, restricted locations, final-Administrator protection and suspended-account recovery | M0 | O0 |
| ACCESS-08 | Implemented; release verification open | Seven-day invitation; native password handoff; canonical session hash; safe server inspection origin; replay-safe transaction; migration 0166 | P acceptance/resend/revoke and authenticatable session; B actual new/existing person invitation, account switch and cross-company denial | M0 | O0 |
| ACCESS-09 | Implemented; release verification open | Show password; support on recovery/confirmation; safe native POST forms | B real no-JavaScript password reset, no automatic login, prior-session revocation and password login in Chromium/WebKit; token-link production delivery remains open | M0 | O0 |
| JOB-01 | Implemented; release verification open | Wizard keyed by account/draft; ordered saves, request isolation, navigation recovery | R actual React draft switch and early Back | M0 | O0 |
| JOB-02 | Implemented; release verification open | booking-location mapping and job-specific contact/instruction defaults | S location mapping; R request component | M0 | O0 |
| JOB-03 | Implemented; release verification open | partner-job-contact and immutable partner-job-location snapshot | P completion snapshot; booking unit tests | M0 | O0 |
| JOB-04 | Implemented; release verification open | Preferred-date reschedule requests, staff accept/decline, original schedule retained; 0164 | P scheduler/review tests; staff UI journey outstanding | M0 | O0 |
| JOB-05 | Implemented; release verification open | Server location pagination and direct lookup; saved request resume | R component; B actual authenticated request at saved location 105 | M0 | O0 |
| JOB-06 | Implemented; release verification open | Server-backed booking location search; portfolio endpoint feature enforcement | B server search beyond first 100, actual review submission and disabled export 404 | M0 | O0 |
| JOB-07 | Implemented; release verification open | Canonical location permissions and permission-derived Add location | S location/role assertions; B actual restricted-location and cross-company denial journeys in Chromium/WebKit | M0 | O0 |
| JOB-08 | Implemented; release verification open | Before/after limits 20 each; 40 photos plus separate bounded 10-PDF allowance; consistent upload/restore/worker checks | S proof schemas and count boundaries; P proof completion | M0 | O0 |
| JOB-09 | Implemented; release verification open | Full-record overview query; scoped issued-only balances; real stored review statuses remain visible without invented arrival windows | P four Home cases: 127 invoices, 120 scoped invoices, Operations financial exclusion/own draft, and unscheduled review request | M0 | O0 |
| JOB-10 | Implemented; release verification open | Full two-hour promises and America/New_York formatting; immutable site timezone | S date/DST helpers; P scheduling | M0 | O0 |
| JOB-11 | Implemented; release verification open | 15-second visible-page refresh; focus/reconnect; timeout/backoff/stale notice | R component harness; full lifecycle browser/failure drills outstanding | M0 | O0 |
| JOB-12 | Implemented; release verification open | PartnerProofWorkspace embedded in the job; explicit job media selection | R wrong-job media regression; P proof ownership | M0 | O0 |
| JOB-13 | Implemented; release verification open | Saved request list/resume/discard with ETag/idempotency and hold release | P draft discard; R autosave/navigation | M0 | O0 |
| JOB-14 | Implemented; release verification open | Durable batch/row history and leases; worker creates actual review/confirmed jobs; 0169 | P 100 rows and concurrent workers: exactly 100 actual jobs | M0 | O0 |
| JOB-15 | Implemented; release verification open | CSV identifiers validated before DB queries; bounded fields and row corrections | P bulk import; scheduling unit validation | M0 | O0 |
| JOB-16 | Implemented; release verification open | Template rename/archive/restore/inspection/search/cursor list; PartnerTemplateDraftReplacement uses saved-request editing and revision-safe replacement | P pagination/scopes/duplicate-name restore/disabled-tool maintenance; R Chromium/WebKit actual replacement UI pagination, 412 recovery, safe retry and template isolation; provider/full-workflow release checks remain open | M0 | O0 |
| PROOF-01 | Implemented; release verification open | Proof component keyed by account/job; in-flight state isolated | R Chromium/WebKit wrong-job regression | M0 | O0 |
| PROOF-02 | Implemented; release verification open | Explicit selected-job lookup, server search and cursor history; missing job never falls back to a different job | R resource switching; old-link and multi-page browser coverage recorded in verification report | M0 | O0 |
| PROOF-03 | Implemented; release verification open | Refreshing signed image URLs and authenticated fresh-download redirects | R proof component; real storage expiry drill outstanding | M0 | O0 |
| PROOF-04 | Implemented; production scanner certification required | PDF signature/hash/10MB gate, private quarantine, leased ClamAV worker | Protocol negatives; real local daemon clean/EICAR checks and PostgreSQL+S3 quarantine-to-ready/account/replay test; production scanner not configured | M0 | O0 |
| PROOF-05 | Implemented; release verification open | Undo, recoverable metadata listing, revision-safe authorized restore within 30 days; permission removal also removes Undo | P ten real restore cases; R Chromium/WebKit photo/PDF Undo, retry, stale-revision refresh, job isolation and read-only controls; full storage/browser release drill remains open | M0 | O0 |
| PROOF-06 | Implemented; release verification open | Background worker; sequential originals/private streamed ZIP; immutable verification; bounded PDF pages and ESM worker runtime | P PDF/ZIP replay/snapshot; actual tsx worker import/render; 40x10MiB proof under256MiB heap; local S3 immutable replay/conflict | M0 | O0 |
| PROOF-07 | Implemented; release verification open | Shared completion dates explicitly service-local | S/source checks; production share smoke outstanding | M0 | O0 |
| COMMS-01 | Implemented; provider certification required | Committed lifecycle/billing/proof/approval events routed to canonical notification deliveries; 0168 | P dedup/scope/access recheck; no real email/SMS delivery certification | M0 | O0 |
| COMMS-02 | Implemented; release verification open | One explicit job thread; job attachment picker and fresh links; contactless staff reply/internal composer | P thread/replay/internal exclusion; actual staff component passes Chromium/WebKit | M0 | O0 |
| COMMS-03 | Implemented; release verification open | Latest-first cursor history; older-message pagination; loaded history survives failure; bounded refresh; ordinary attachment links | P message data boundary; R Chromium/WebKit actual multi-message history, retry with draft/attachments, cursor preservation and account/job isolation | M0 | O0 |
| COMMS-04 | Implemented; release verification open | Safe actual author names and current-person flag | P thread author/source checks; R actual teammate/You rendering and job-bound attachments in Chromium/WebKit | M0 | O0 |
| COMMS-05 | Implemented; release verification open | Updates history, pagination, scoped events, non-blocking mark-read; bounded batches; successful history retry clears its stale error | P financial notice scopes; R Chromium/WebKit paging, partial mark-read failure, loaded-history retention and job navigation while marking read is unavailable | M0 | O0 |
| COMMS-06 | Implemented; release verification open | Own-phone verification requires portal.session.read, not administrator permission | S endpoint authorization tests | M0 | O0 |
| COMMS-07 | Implemented; release verification open | Reduced-motion aware scroll; preserve position while viewing older history | B reduced-motion setting; manual interaction still required | M0 | O0 |
| BILL-01 | Implemented; release verification open | Separate operational/financial report authorization and workflow gate | P report-specific authorization and fixed snapshots; provider calls mocked | M0 | O0 |
| BILL-02 | Implemented; release verification open | Invoice/statement history, complete per-invoice staff document/refund cursors and bounded fixed-snapshot CSV/PDF exports | P ledger/documents, 521-document/537-refund history and report pagination; R staff retry/currency/invoice switching | M0 | O0 |
| BILL-03 | Implemented; release verification open | Issued-only payable aggregates; shared CRM ledger; protect unexplained historical paid principal; statement-period refund splits; due-date status derived consistently | P invoice financial cases, scalar-preservation regression, split refunds across statement periods, draft/void totals and due-day/DST tests | M0 | O0 |
| BILL-04 | Implemented; release verification open | Date/location/service/status/requester/reference/proof/financial filters and safe exports | P actual CSV/PDF generation, bounded snapshots, filter and scope tests | M0 | O0 |
| BILL-05 | Implemented; release verification open | Server-derived capabilities/payment readiness control billing actions | S payment UI contracts; B four-role login and hidden operational-only billing summaries | M0 | O0 |
| STAFF-01 | Implemented; release verification open | Team settings distinguish unavailable membership/invitation reads from empty lists | S/source checks; degraded staff browser drill outstanding | M0 | O0 |
| STAFF-02 | Implemented; release verification open | PartnerRelationshipSetup, explicit approval, roles/scopes, invitation history, workflow controls | P access/invitation lifecycle; no real external sends | M0 | O0 |
| STAFF-03 | Implemented; release certification open | PartnerBillingAdministration; immutable issued records; explicit multi-payment/refund correction and evidence-backed historical cash/check principal repair; documents/credits/refunds/statements; migrations 0171–0172. Owner-approved extra work is a separately priced/billed linked job via createPartnerAdditionalServiceDraft, PartnerAdditionalService and normal submission; original money/payout unchanged. Staff quote decisions now forward the selected quote; cancellation no longer includes that unrelated field. | P correction/replay/cross-account/concurrency/statement/historical receipt cases; linked review and held submissions, separate child invoice/payment/commission, original financial snapshot preservation and actual suspension races. R Chromium/WebKit linked-job navigation/retry/account isolation/read-only original plus real server-action payload checks; details in September 9 report. | M0 | O0 |


### Current evidence key and release boundary

Implementation references above are repository file/module names. `S` is the API/Site automated contract and unit lanes (`pnpm test:partner-portal:api`, `pnpm test:partner-portal:site`); a source assertion is not an end-to-end result. `P` is real PostgreSQL 16 in a disposable local Docker database. The earlier September 9 aggregate used 169 migrations through 0171; the approved additional-service implementation is tested on 170 migrations through 0172, not production. `R` is the actual React component browser harness (`scripts/test-partner-resource-components.mts`, `scripts/test-partner-booking-components.mts`, `scripts/test-partner-staff-inbox.mts`, `scripts/test-partner-staff-reconciliation.mts`, `scripts/test-staff-schedule-resources.mts`, `scripts/test-partner-additional-service-components.mts`). `B` is the local rendered-page browser suite (`scripts/test-partner-service-browser.mts`, `scripts/test-partner-local-service-journey.mts`, `scripts/test-partner-access-local-journey.mts`). Provider calls and object storage in database tests are controlled fakes where noted; real localhost scanner/S3 checks are identified separately.

`M0`: updated-flow manual screen-reader, physical-device, staff-training and representative-user certification has not been performed. Automated screenshots/Axe do not substitute for it. `O0`: no deployment, production migration, flag change, real message, payment or live monitoring was performed during implementation. Production counts from the original audit are historical and must be rechecked before cutover.

September 8 local evidence: 168 migrations applied to a new database, followed by a local backup/restore rehearsal. Sixty public-page Axe scans across Chromium, Firefox and WebKit at 320, 375, 768, 1024 and 1440 px had zero violations and no horizontal overflow. Ten additional authenticated Chromium scans passed across four role-specific Home views, the four request steps, the submitted job and older-job proof search. The no-JavaScript sign-in POST passes after correcting tokenless form privacy headers. An actual four-role login/request journey found and fixed a trusted local-origin mismatch; an Operations user now searches for saved location 105 and submits a real review request without a promised time. The rendered history journey exercises more than 100 jobs, exact older-job links and safe missing-job recovery. Real database scheduling includes weighted concurrency, durable 100-row import/retry, ongoing recurrence snapshots, proof gating, invitation races and shared financial records. The CRM status route's 28 tests pass with its new partner-lifecycle dependency isolated; separate real-database tests establish that ordinary CRM jobs are not partner-proof jobs. Existing commission/expense/payout database and calculation tests passed. These are local results, not production or complete end-to-end provider certification.

September 9 final aggregate: API 116 suites / 852 passing tests (61 opt-in database cases skipped in that lane), Site 167 passing tests, and a separate real PostgreSQL lane with 37 suites / 185 passing tests and no skips on the fresh 169-migration schema. Both production builds passed with type validation enabled; the repository lint gate reports zero errors without changing the baseline. Additional actual HTTPS invitation/recovery/company-switching journeys passed in Chromium and WebKit with ten clean authenticated Axe scans; reflow emulation is not native browser-zoom certification. Eight additional template/proof/messages/updates component browser cases passed with explicitly stubbed network. See the continuation report for exact commands, logs, runtime checks and remaining release gates.

This is not a declaration that all 60 findings are closed. The [September 9 continuation and current release gates](./partner-portal-completion-verification-2026-09-09.md) supersedes completed gaps in the earlier [handoff report](./partner-portal-remediation-verification-2026-09-08.md). Migration 0171 brings the fresh/restore rehearsal to 169 entries. The global switch must stay blocked until remaining decisions, verification and applicable historical gates are resolved. See the [relationship-first release runbook](../runbooks/partner-relationship-service-release.md).

## Historical audit — bottom line

**The portal is not a subscription product, but it still looks and behaves too much like a software product being introduced to prospective customers. It is not yet the simple, dependable service desk described by the owner.**

The headline now says “Quick and easy service for our partners.” That change did not remove the product-demo landing page, public application funnel, promotional sign-in panel, dashboard setup exercises, or advanced tools placed before the basic request form.

There are useful implementations worth retaining: saved locations, service requests, schedule checks, photos, job records, changes, messages, and service-related billing. Invoices and account permissions are not evidence of a portal subscription. I found no portal subscription plans, recurring software fees, free-trial purchase flow, or paid feature upgrade checkout. The problem is unnecessary customer-facing complexity and incomplete connections between useful features—not a subscription hidden in the code.

There are also genuine defects. Browser checks reproduced wrong-job photo state, wrong-draft editing, and an invitation role mismatch. The live password-reset form has an unsafe default-GET fallback when JavaScript is unavailable. Other source-confirmed problems affect saved contacts, rescheduling, notifications, reports, and record retrieval. This report records **60 consolidated findings**, separating defects, design mismatches, and operational readiness gaps.

The live deployment is not operationally set up for partners: the audited active database has no portal identities or memberships, no enabled portal accounts, and no current partner service agreements. The public application API returned 503. Publishing the pages did not complete partner access or scheduling setup.

## The owner's current product direction

- This is a convenience for people Stonegate already has relationships with.
- Its main purpose is requesting and scheduling Stonegate service.
- It is not a SaaS offering, subscription, or broadly marketed standalone product.
- Access requests and trouble should lead directly to Stonegate Sales by email or phone.
- Keep ordinary password authentication and account separation. This audit does not recommend restoring MFA.
- Keep valuable secondary functions, but do not make partners learn them before requesting service.

The user supplied `sales@stonegatejunkremoval` without a domain suffix. The configured company profile and the live landing page both use **sales@stonegatejunkremoval.com**. This report uses that complete existing address and **404-777-2631**, not an invented address.

Suggested universal support wording:

> Need access or help? Email sales@stonegatejunkremoval.com or call 404-777-2631.

These decisions supersede the older public-acquisition positioning. The historical [99-finding audit](./partner-portal-audit.md) is preserved unchanged. This supplementary review neither adds a 100th row to that ledger nor marks its existing findings closed.

## Scope, evidence, and limits

The inventory contains **28 partner page components, 44 shared partner components, six partner page-route handlers, 118 portal API route handlers, and 45 canonical staff partner-management API route handlers**. The audit followed the page flows and their primary operations into authorization, scheduling, media, messaging, commercial, onboarding, and staff services. Legacy portal adapters and the public authentication helpers were included where those flows depend on them.

Evidence labels used below:

- **Live:** observed through read-only requests, actual public-page browser inspection, or aggregate queries against the active database.
- **Reproduced:** actual repository React component exercised in an isolated browser with synthetic data and mocked network responses. This is stronger than source inspection, but is not a production end-to-end journey.
- **Source:** the implementation shows the mismatch; the specific action was not executed against production.
- **Design:** a judgment against the owner's stated purpose, not necessarily a software error.
- **Unverified:** provider, operational, or user testing is still needed; it is not being described as a proven outage.

P1 means address before relying on this workflow with partners. P2 means a material usability, completeness, or reliability problem. P3 means secondary polish or convenience. These are priorities within this supplementary review, not edits to the historical ledger's severity ratings.

No production account, application, job, payment, message, invitation, or configuration was created or changed. Production browser requests that could submit forms or analytics were blocked; isolated component tests deliberately sent requests to mocked local handlers. Database inspection used read-only transactions. No real password or activation token was submitted. Only this audit document was added to the repository.

### Checks executed now

| Check                           | Actual result                                                                                                                         | What it does not establish                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Partner Site test lane          | 140 passed, zero failed                                                                                                               | Many tests inspect source/contracts, not complete customer journeys.               |
| Partner API test lane           | 105 suites / 789 tests passed; 12 suites / 46 tests skipped                                                                           | No new real-PostgreSQL concurrency or provider certification run.                  |
| Live public Chromium inspection | 23 route visits at 1440 px plus six at 320 px; no page JavaScript errors or horizontal overflow observed                              | Protected visits checked signed-out redirects, not logged-in pages.                |
| Automated accessibility         | Zero Axe violations in the five scanned public states at both widths: landing, login, access request, forgot password, and activation | Not a whole-portal WCAG certification, screen-reader test, or real-device test.    |
| Password-reset fallback         | Live JavaScript-disabled DOM: form method resolves to GET; named password fields present; no submission                               | No claim that a real partner's password was leaked.                                |
| Saved-draft switching           | Actual wizard in Chromium retained and PATCHed draft A after receiving draft B                                                        | Next.js navigation and production persistence were not exercised end to end.       |
| Photo-job switching             | Actual proof component in Chromium and WebKit retained A's photo under B and targeted `/jobs/B/proof/A`                               | No demonstrated cross-account exposure or successful unauthorized deletion.        |
| Invitation role                 | Actual form in Chromium and WebKit displayed Administrator but sent an empty role                                                     | No invitation was created; API responses were mocked.                              |
| Active production readiness     | Database target matched the deployed API configuration; counts and feature configuration inspected                                    | No legitimate signed-in partner session was available for a live customer journey. |

The browser-rendered public evidence came from `https://stonegate-site.onrender.com`. Local Chromium/curl could not negotiate TLS with the custom domain during this run, but an independent web retrieval successfully read `https://stonegatejunkremoval.com/partners`. **Do not interpret the local TLS failure as a proven customer-facing outage.** Custom-domain browser/device smoke testing remains appropriate.

Current diagnostic artifacts, outside the repository:

- `/tmp/stonegate-partner-audit.LJ9Bdq/public-audit.cjs` and `public-results.json`: public route/browser matrix and screenshots.
- `/tmp/stonegate-partner-audit.LJ9Bdq/read-readiness.mjs`: credential-safe, read-only inspection of allowlisted deployment flags; no credential values stored in the script.
- `/tmp/stonegate-partner-draft-audit.mtcRtv/check.mts`: actual wizard draft-switch reproduction.
- `/tmp/stonegate-partner-audit.XCu3hZ/check.mts`: actual invitation/proof reproductions in Chromium and WebKit.

Temporary artifacts may be removed by the operating system; the observations and source references are retained in this document.

## Page-by-page examination

Paths below are relative to `/partners` unless otherwise stated. “Present” means implemented in source, not certified as operational in production.

| Page or surface                    | Present purpose/function                                                                                | Verdict and needed direction                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/partners`                        | Public entry, demo workspace, benefits, process, FAQ, sign-in/access CTAs                               | Still a product introduction. Replace the pitch with a short existing-partner entrance and visible Sales contacts.                                           |
| `/login`                           | Password, remember-me, recovery, safe return                                                            | Useful core form, but the mobile promotional panel comes before it. Remove that panel; add direct access/help contacts.                                      |
| `/request-access`                  | Email verification into an application                                                                  | Wrong front door for the new relationship-only model. Direct to email/call; retain safe recovery for any old links.                                          |
| `/application`                     | Company profile, needs, matching, submit/respond/withdraw/status                                        | Overbuilt for known relationships, with saved-draft recovery defects. Move relationship decisions to staff.                                                  |
| `/activate`                        | Invitation/account inspection, password setup/confirmation, resend                                      | Necessary capability; too many email steps and weak help paths. Keep a short, dependable activation.                                                         |
| `/activate/mfa`                    | Deprecated redirect                                                                                     | No active MFA enrollment here. Do not report MFA as still required.                                                                                          |
| `/forgot-password`                 | Neutral recovery request                                                                                | Keep; fix no-JavaScript behavior and missing email/help link.                                                                                                |
| `/reset-password`                  | Password setup using a purpose-bound credential                                                         | Keep; unsafe form fallback is a pre-release fix.                                                                                                             |
| `/login/mfa`                       | Deprecated redirect                                                                                     | No active MFA login prompt here.                                                                                                                             |
| `/confirm-email`                   | Confirm sensitive email change                                                                          | Useful security function; simplify error/recovery and acknowledge successful change at sign-in.                                                              |
| `/invitations/accept`              | Accept invitation, then queue separate activation                                                       | Useful relationship access, but unnecessary waiting and repeated email/password steps.                                                                       |
| `/unavailable`                     | Private degraded-session page                                                                           | Safe approach; add direct support rather than only retry. Direct URL correctly returns to the entrance.                                                      |
| `/proof/[token]`                   | Expiring read-only completion/proof share                                                               | Valuable operational function, not something to market as a product feature. Improve dates, downloads, and help.                                             |
| `/overview`                        | Setup checklist, suggestions, statistics, notifications, quick actions, next job                        | Too much setup before useful work; some totals are incomplete or misleading. Show request action and next job first.                                         |
| `/book`                            | Drafts, saved locations, service/scope, contacts, photos, availability, review/submit; repeat/CSV tools | Core task exists but is buried and too long. Fix wrong-draft state and saved defaults; move advanced tools out of the way.                                   |
| `/bookings`                        | Job search/filter/pagination and actions                                                                | Keep as “My jobs.” Correct local dates, full arrival windows, and status freshness.                                                                          |
| `/bookings/[jobId]`                | Timeline, status/ETA, details, changes/cancellation, messages, proof summaries, documents               | Right place to consolidate job work. Correct job contact, show actual photos, and keep updates current.                                                      |
| `/bookings/[jobId]/reschedule`     | Replacement draft/hold/window selection                                                                 | Review fallback is contradictory and blocked when instant eligibility is absent. Preserve the old appointment while accepting a real review request.         |
| `/properties`                      | Location directory, details, defaults/favorites, contacts, archive/restore, merge, import/export        | Useful for repeat partners, but search is limited to loaded records and booking does not reuse enough defaults. Hide portfolio administration unless needed. |
| `/photos`                          | Job selector, gallery, uploads, comparison, requirements, packages, sharing                             | Two wrong-job defects make this high priority. Prefer a job-linked gallery; keep an all-jobs view secondary.                                                 |
| `/billing`                         | Rates/agreement, invoices/payments, quotes, statements, documents, disputes                             | Actual service billing, not subscription pricing. Put unpaid invoices first and support complete history.                                                    |
| `/billing/quotes/[partnerQuoteId]` | Proposal details/options/document, accept/decline                                                       | Legitimate service workflow. Keep contextual and remove internal security explanations.                                                                      |
| `/approvals`                       | Filtered/paginated approval requests                                                                    | Useful only for relationships that require approvals; do not make it everyday navigation for everyone.                                                       |
| `/approvals/[requestId]`           | Request details, immutable decisions, approval history                                                  | Keep permission checks and self-approval protection; expose only when relevant.                                                                              |
| `/reports`                         | Invoice aggregates, statement periods, CSV                                                              | Duplicates Billing and fails some advertised roles. Repair or fold into appropriate history/export views.                                                    |
| `/settings`                        | Profile, password/email, account configuration, sessions, notification matrix, SMS, proof defaults      | Too much at once. Separate simple personal settings from advanced company administration.                                                                    |
| `/settings/team`                   | Invitations, joins, member roles/status                                                                 | Valuable for larger partner teams, not the normal request path. Fix invitation role and loading-state defects.                                               |
| `/help`                            | Call, text, email, hours, FAQs, policy links                                                            | Helpful content but protected by login. Access trouble needs public, immediate email/call links.                                                             |

### Shared, API, and staff functions examined

| Function group          | Coverage and disposition                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public/protected shells | Header action policy, desktop sidebar, mobile drawer/bottom navigation, account switching, skip links, loading/error states, page headers, badges, form primitives. Good foundations, too many repeated controls and explanations.                                                                                            |
| Public handlers         | `/verify`, `/auth`, `/logout`, `/application/expired`, `/invitations/accept/complete`, `/social-image`; token transfer, cookie clearing, redirects, sign-out recovery, promotional image.                                                                                                                                     |
| Account/identity APIs   | Principal/session, memberships/accounts, account switching, session revocation, personal/account profile, password/email change, applications, company joins, invitations and activation. No broad public signup authority is granted solely by verifying email.                                                              |
| Request/schedule APIs   | Draft create/read/patch/validate/submit, service catalog, arrival windows, holds, reschedule, cancellation, cancellation policy, references, change requests, duplicate, templates, recurring series, bulk intake. Review defaults and safe scheduling checks must stay.                                                      |
| Location APIs           | List/detail/create/update, verification, favorites/defaults, archive impact, restore, same-account merge, CSV dry-run/commit/corrections/export, private access details. Directory and booking need consistent search/default/scope behavior.                                                                                 |
| Media/proof APIs        | Explicit draft/job association, upload intents/finalization/deletion, categories/requirements, download intents, comparison, completion gates, PDF/ZIP packages, hashed expiring/revocable shares. UI continuity, documents, recovery and live storage evidence remain incomplete.                                            |
| Communication APIs      | Job threads/messages, internal visibility exclusions, unread notifications, read/read-all, preferences and verified SMS endpoints. Missing attachment UI and lifecycle delivery wiring are material.                                                                                                                          |
| Commercial APIs         | Quotes/decisions/documents, approvals, invoices, disputes, hosted links, embedded payment intents, statements, documents/downloads, financial reports/export. Account authorization exists; completeness and provider execution cannot be inferred from page existence.                                                       |
| Legacy adapters         | Old contact-oriented booking/properties/rates/password/me/logout paths inventoried alongside V2. Do not restore contact-derived authority as a simplification shortcut.                                                                                                                                                       |
| `/team/partners`        | Accounts, people/memberships/invitations, applications/joins/domains, security/quarantine, commercial configuration, cancellations/job changes/billing requests, address review/merge, operational health and read-only preview. Staff tooling is substantial but fragmented; invoice/statement execution remains incomplete. |
| Marketing connections   | Main header/footer partner links, sitemap/indexability, metadata/social image, separation from marketing scripts. A utility link is useful; broad acquisition positioning is not the current goal.                                                                                                                            |

## 1. Live readiness problems

### LIVE-01 — Public access pages are available while the access service is disabled (P1, Live + Source)

Read-only deployment inspection found no explicit service-level values for portal V2 reads/writes, purpose authentication, instant confirmation, hosted/embedded payments, or outbound partner notifications. These operational flags default off in production. A direct GET to the active API's `/api/portal/v2/onboarding/application` returned **503 `service_unavailable`**, consistent with the purpose-auth gate executing before authentication.

The public request-access form is still displayed. Do not enable everything indiscriminately: first decide the short relationship-based access flow, configure it deliberately, and verify it end to end. No verification-email POST was sent during this audit.

Evidence: `apps/api/src/lib/feature-flags.ts:9`; `apps/api/src/lib/partner-portal-feature-flags.ts:40`; `apps/api/app/api/portal/v2/onboarding/application/route.ts:35`; `apps/api/app/api/portal/v2/onboarding/email-challenges/route.ts:29`; `render.yaml:203`.

### LIVE-02 — No partners or account service agreements are operationally configured (P1, Live)

At inspection, the active database returned: **0 partner identities; 0 memberships; 0 enabled portal accounts; 0 access applications; 0 currently active service agreements**. The deployed API's configured database hostname was verified against this database without printing credentials.

This means a real returning-partner journey could not be tested. Staff need a small reliable “set up this known company and invite this person” workflow, appropriate defaults, and a Stonegate-owned acceptance test before handing out links. Account creation alone is insufficient: the service catalog returns no account offerings without an effective agreement.

Evidence: read-only aggregates of `partner_users`, `partner_account_memberships`, `partner_accounts`, `partner_access_applications`, `partner_account_service_agreements`; `apps/api/src/lib/partner-portal-v2-service-catalog.ts:114`.

### LIVE-03 — Schedule-backed availability is not ready merely because the picker exists (P1, Live + Source)

The database contains four active catalog services, two active scheduling profiles, and **no recorded external-busy coverage synchronization timestamp**. Coupled with missing active account agreements and disabled instant-confirmation configuration, the evidence does not support promising instant bookings.

Configure only the actual services offered to each relationship, verify operating capacity and Google busy coverage, and keep uncertain work as a clearly acknowledged review request. Do not remove freshness or capacity protection to make slots appear.

Evidence: read-only `partner_service_catalog`, `partner_scheduling_profiles`, `calendar_sync_state.external_busy_coverage_synced_at`; scheduling eligibility and hold services.

## 2. Positioning, clutter, and unnecessary work

### DESIGN-01 — The entrance remains a product pitch (P2, Design + Live)

The landing contains five sections, a demonstration workspace, audience chips, multiple feature/process explanations, account-access instructions, FAQs, and repeated CTAs. The live 320 px page measured approximately **5,099 px tall**; desktop approximately **2,743 px**. This is not evidence of a rendering bug, but it is excessive for a known partner who needs to sign in or reach Stonegate.

Replace it with a compact partner entrance: a short purpose statement, sign-in, and direct access/help contacts. The sample workspace is honestly labeled but unnecessary here.

Evidence: `apps/site/src/app/partners/components/PartnerLandingContent.tsx:147`; `PartnerPortalPreview.tsx:3`; live screenshots.

### DESIGN-02 — Access still resembles acquiring a software account (P1 product fit, Source)

“Request access” starts email verification, company details, persona/needs selection, workspace matching, approval, and activation. That is not the new instruction to contact a known Stonegate relationship. Keep staff approval/account boundaries internally; make public access requests email/call. Preserve recovery for existing links rather than abruptly deleting handlers.

Evidence: `(public)/login/page.tsx:194`; `PartnerAccessRequestForm.tsx:64`; `PartnerApplicationWorkspace.tsx:705` under `apps/site/src/app/partners/`.

### DESIGN-03 — Sign-in is below another sales panel on mobile (P1 usability, Live + Source)

At 320 px, the login page is about **1,467 px** tall and puts a large benefits panel before the email/password form. The access page is about **1,314 px** and repeats this ordering. A returning partner has already chosen to use the portal. Show the form immediately; remove the promotional block.

Evidence: `(public)/login/page.tsx:59`; `PartnerAccessRequestForm.tsx:127`; current live screenshots.

### DESIGN-04 — Search/social promotion still assumes public acquisition (P2, Design)

The landing is explicitly indexable, included in the sitemap, has a product-specific social image, and is promoted through several footer links. A findable utility entrance is not inherently wrong, but it should not read as broad recruitment. Retain a simple “For Partners” utility link; decide whether the short entrance should remain searchable or be noindex. Noindex is not access control.

Evidence: `(public)/page.tsx:15`; `(public)/social-image/route.tsx`; `apps/site/src/app/sitemap.ts:46`; `apps/site/src/components/Footer.tsx:104`.

### DESIGN-05 — Navigation makes this feel like an enterprise suite (P2, Design)

There are up to nine primary destinations plus settings, with a second Request service action. Shell title, breadcrumb, eyebrow, large page card, and repeated quick actions all compete for attention. Use **Request service, My jobs, Saved locations, Help** as the everyday structure. Keep authorized Billing accessible but secondary; show approvals only where used.

Evidence: `PartnerAppShell.tsx:50,477`; `PartnerPortalUi.tsx:79`.

### DESIGN-06 — Overview puts setup before the next job (P2, Design)

Checklist, persona suggestions, summary cards, notifications, and quick-action cards precede the next scheduled job. Existing partners should see the request button, next job, and genuinely required action first. Setup can be small, dismissible, and out of the main path.

Evidence: `(portal)/overview/page.tsx:326,338,345,409,452`.

### DESIGN-07 — Advanced tools precede the actual request form (P1 usability, Source)

An expanded panel for suggestions, saved templates, recurring work, and CSV intake appears before the six-step wizard. It is optional machinery placed in the way of the primary task. Move it behind “Repeat a previous job” or an advanced menu; do not require scrolling past it.

Evidence: `(portal)/book/page.tsx:548`; `PartnerRepeatWorkManager.tsx:345,388,439`.

### DESIGN-08 — Routine booking asks users to navigate too much optional detail (P2, Design)

The wizard exposes persona guidance, commercial terms, hazard/equipment questions, contacts, alternate contacts, deadlines, proof presets/counts, billing/reference fields, and many arrival-window cards. Some fields are necessary for some jobs, but they should not all appear equally important. Start with location, work description/photos, date, and confirmation; reveal extra questions when the selected work requires them. Use a compact date-first picker rather than a month-long card wall.

Evidence: `PartnerBookingWizard.tsx:178,1615,2009,2200,2420,2530,2969`.

### DESIGN-09 — Billing, settings, and proof explain their implementation too much (P2, Design)

Billing stacks agreements, rates, invoices, quotes, statements, and documents. Settings combines profile, password, email changes, company details, account switching, sessions, SMS verification, ten notification families, quiet hours, and proof defaults. Proof emphasizes packages, versions, checksums and authorization language. Prioritize the task; put technical record details and advanced company controls behind disclosure sections.

Examples to remove or rewrite: “upgraded partner account,” “presentation only,” “capacity reservations,” “30-day horizon,” and security assurances about internal data that the partner never asked to see. Explain outcomes: “We received your request,” “Your time is confirmed,” “Call us if this is urgent.”

Evidence: `PartnerPersonaOverviewGuide.tsx:89`; `PartnerRepeatWorkManager.tsx:217,848`; `(portal)/billing/page.tsx:208`; `(portal)/settings/page.tsx:187`; `apps/api/src/lib/partner-portal-v2-scheduling/service.ts:396`.

### DESIGN-10 — Direct human help is missing at the point of failure (P1 access/usability, Live + Source)

The public shell has a desktop call link and a mobile footer Call link but no email. Login/reset/invitation/error screens often say “contact Stonegate” or “ask your administrator” without a direct destination. The Help page itself requires a valid sign-in, so it cannot be the only answer for access trouble. The protected shell and generic error component also lack the universal email/call block.

Make the existing Sales email and phone visible on every access, recovery, unavailable, empty-configuration, and failed-request state. Use the two requested channels; do not make a Text card a competing default unless the owner chooses that separately.

Evidence: `PartnerPublicShell.tsx:60,79`; `(public)/login/page.tsx:34,115`; `PartnerCredentialSetupForm.tsx:251,370`; `(public)/invitations/accept/page.tsx:66`; `PartnerPortalUi.tsx:212`; `(portal)/help/page.tsx:37`; live login/reset DOM contains no mailto link.

## 3. Access and recovery defects

### ACCESS-01 — Passwords can fall into a URL if JavaScript is unavailable (P1, Live DOM + Source)

The reset/credential form has client `onSubmit` but no explicit method/action. Its password fields are named. Native browser form behavior therefore defaults to GET. On failed hydration or disabled JavaScript, submission would put password fields into the page query string instead of resetting the password. The actual live DOM confirmed this default; no password was entered or sent.

Access-request and password-recovery email forms have the same pattern, exposing email in the URL and failing their intended action without JavaScript. Use safe explicit POST/server handling or a safe non-submitting fallback with clear help. Do not rely on a client event handler to prevent credential GET submissions.

Evidence: `PartnerCredentialSetupForm.tsx:268,279`; `PartnerAccessRequestForm.tsx:191`; `PartnerPasswordRecoveryForm.tsx:116`.

### ACCESS-02 — Saved application work is not restored by the new link the UI recommends (P1, Source)

“Save and finish later” says the person can return using a new verification link. Saving writes only the current applicant session's draft. Consuming a new verification link creates another session and does not copy that pre-submission draft. The advertised resume method therefore loses the saved work from view.

Evidence: `PartnerApplicationWorkspace.tsx:445,1243`; `apps/api/src/lib/partner-verification-onboarding.ts:244,282,744`; `apps/api/src/lib/partner-purpose-auth.ts:348,388`.

### ACCESS-03 — Fresh-link status recovery can forget an approval or decline (P2, Source)

New verification sessions look up submitted/under-review/needs-information applications, not the already approved/declined/withdrawn outcome. Old bound sessions can still show the decision; a fresh link can instead lead back to a blank draft. Preserve access/status recovery without suggesting that already reviewed people should reapply.

Evidence: `apps/api/src/lib/partner-purpose-auth.ts:348`; `apps/api/src/lib/partner-verification-onboarding.ts:282`.

### ACCESS-04 — Application edits can be lost both before and during save (P2, Source)

There is no automatic save or navigation warning. During an explicit save, fields remain editable, but the response replaces the entire form with the older submitted snapshot. Closing/leaving loses unsaved work; typing during slow save can be overwritten. If this application remains reachable, protect both cases even if it is no longer promoted publicly.

Evidence: `PartnerApplicationWorkspace.tsx:310,354,372,385,413`.

### ACCESS-05 — Network failure produces misleading recovery (P2, Source)

Password login does not catch a thrown API/network timeout, bypassing the friendly returned-error message. Verification catches a failed request but can label a network failure or rate limit as an invalid/expired link. Distinguish “try again” from “request a new link,” keep existing context, and offer Sales help.

Evidence: `actions.ts:88`; `lib/api.ts:33`; `verify/route.ts:23`; `(public)/login/page.tsx:34`.

### ACCESS-06 — Applicant navigation has contradictory destinations (P2, Source)

The application's “Partner Portal information” link points to `/partners`, which immediately redirects applicant-cookie users back to the application. Request-access checks the applicant cookie before valid partner context, unlike the root's partner-first precedence. Align cookie handling and replace self-returning links with useful information/contact destinations.

Evidence: `PartnerApplicationWorkspace.tsx:622`; `(public)/request-access/page.tsx:21`; `apps/site/src/middleware.ts:165`.

### ACCESS-07 — Invitation role shown and role submitted disagree (P1, Reproduced)

The invitation form starts with an empty role state but has no “Choose a role” option. Chromium and WebKit displayed Administrator and considered the select valid, while the outgoing request contained `roleKey: ""`. The submit button was enabled. Add an explicit placeholder and require deliberate selection; never silently grant the first role.

Evidence: `PartnerInvitationManager.tsx:84,111,235,268`; isolated actual-component tests.

### ACCESS-08 — Invitations and activation are unnecessarily hard to finish (P2, Design + Source)

Invitation acceptance queues a separate activation email; invitation links last 30 minutes; existing identities are asked to repeat their current password in activation. Login has no obvious “activation email never arrived” help action. Consolidate the safe invitation/activation handoff where possible and show direct Sales help while preserving neutral authentication responses.

Evidence: `(public)/invitations/accept/page.tsx:48`; `PartnerInvitationManager.tsx:127,190`; `apps/api/src/lib/partner-account-invitations.ts:36`; `PartnerCredentialSetupForm.tsx:203,275`; `(public)/login/page.tsx:25`.

### ACCESS-09 — Secondary recovery and confirmation polish is incomplete (P3, Source)

Login lacks a show-password control; credential errors are mostly global rather than linked to the affected field; email-change success sends `emailChanged=1` to login without an acknowledgment; application withdrawal is immediate without confirmation. These are small individually but matter to people who use the portal infrequently.

Evidence: `(public)/login/page.tsx:43,158`; `PartnerCredentialSetupForm.tsx:119,251`; `PartnerEmailChangeConfirmation.tsx:68`; `PartnerApplicationWorkspace.tsx:455,615,1102`.

## 4. Service-request and job defects

### JOB-01 — Opening a different saved request can still edit the old draft (P1, Reproduced)

Template application navigates to another `draftId` on `/book`. The wizard is unkeyed and copies `initialDraft` into state only on first mount. An actual-component Chromium test changed the supplied draft from A to B; the location and description stayed A, and Continue PATCHed A. Reset/key the complete request state and protect unsaved work during the handoff.

Evidence: `PartnerRepeatWorkManager.tsx:172`; `(portal)/book/page.tsx:572`; `PartnerBookingWizard.tsx:637,662,687,749`.

### JOB-02 — Saved location contacts and instructions do not properly prefill a request (P1, Source)

The booking page reduces a location to ID/name/address/service-area/timezone, discarding contact, access, parking/loading and favorite/default information. Choosing it does not prefill required contact fields. Partners must retype details they were told to save once. Carry safe defaults through, keep private codes separately protected, and distinguish defaults from per-job overrides.

Evidence: `(portal)/book/page.tsx:78`; `PartnerBookingWizard.tsx:212,597,960`; `PartnerLocationManager.tsx:1490`.

### JOB-03 — The job page can show the wrong on-site contact (P1, Source)

Submission saves a job-specific contact, but job detail projects the location's default contact. A one-time contact supplied for this visit can be replaced in the visible job record by another person or “Not provided.” Render the job snapshot first, with appropriate fallback only for older records.

Evidence: `apps/api/src/lib/partner-portal-v2-scheduling/service.ts:3557,4140`; `apps/api/app/api/portal/v2/jobs/[jobId]/route.ts:188,707`; `(portal)/bookings/[jobId]/page.tsx:934`.

### JOB-04 — Rescheduling has no review fallback when instant eligibility is already unavailable (P1, Source)

The reschedule screen says a stale-calendar request can be reviewed, yet selecting a window requires a hold that the shared service rejects whenever instant eligibility is absent. Submit requires that hold. Late-cutoff review can still work with an eligible hold; the defect is not every review-mode reschedule. Add a genuine preferred-window reschedule review path; retain the old confirmed booking until Stonegate approves the replacement.

Evidence: `PartnerRescheduleFlow.tsx:229,318,449`; `apps/api/src/lib/partner-portal-v2-scheduling/service.ts:2830,4465`.

### JOB-05 — Valid locations disappear from booking after the first page (P2; P1 for affected portfolios, Source)

Booking loads only 100 locations, ignores the cursor, has no search/load-more, and rejects a selected deep-linked location not in that batch. The directory can contain the location while the request picker cannot select it. Use server-backed search and resolve the requested location independently of the first page.

Evidence: `(portal)/book/page.tsx:401,577`; `PartnerBookingWizard.tsx:1540`.

### JOB-06 — Location search can falsely report no match (P2, Source)

The directory searches only already-loaded rows. A matching location on a later page looks absent despite API support for search. Search across the account on the server, not just the browser's current batch.

Evidence: `PartnerLocationManager.tsx:217,679,904`.

### JOB-07 — Inline location creation ignores scope restrictions shown correctly elsewhere (P2, Source)

Scoped Operations users can be offered Add location based on `properties.manage`, but the API requires account-wide access. The standalone directory correctly uses the narrower portfolio permission. Use the same allowed-action result in both places and offer Stonegate help when creation is unavailable.

Evidence: `(portal)/book/page.tsx:590`; `PartnerInlineLocationForm.tsx:67`; `apps/api/app/api/portal/v2/locations/route.ts:271,324`.

### JOB-08 — Proof quantity controls and validation disagree (P2, Source)

Booking controls allow up to 40 before/after photos as a requirement, while server draft validation permits at most 20 per category. A user can select an option that later prevents continuation. Derive limits from one contract and keep the simple default prominent.

Evidence: `PartnerBookingWizard.tsx:2646`; `apps/api/src/lib/partner-portal-v2-scheduling/domain.ts:1295`.

### JOB-09 — Overview summaries can omit real work and double-count attention (P2, Source)

Overview derives its next job and summaries from bounded recent batches, ordered by creation rather than the upcoming arrival. Older-created future work can be omitted. Approval jobs can contribute to both action-job count and approval count; requests waiting on Stonegate can appear as attention required from the partner. Invoice balances likewise come from a bounded batch and can include draft invoices: the calculation excludes paid/void, but the listing does not exclude drafts by default. Billing-denied roles see an unnecessary “Unavailable” balance card.

Use targeted next-job/action queries and role-appropriate summaries, or remove statistics that do not help the task. Do not present a partial sum as the account's total balance.

Evidence: `(portal)/overview/page.tsx:115,160,217,230,359,369,472`; `lib/portal-commercial.ts:279`; `apps/api/src/lib/partner-portal-v2-commercial.ts:480`; `apps/api/app/api/portal/v2/jobs/route.ts:430`.

### JOB-10 — Dates and arrival promises are inconsistent (P2, Source)

Job filters turn local date selections into UTC midnight/day-end boundaries. For Eastern users, those are four/five hours early. List/overview also display only the window's start, while detail shows the full range. Use explicit service-local day boundaries and consistently display “10 AM–noon,” not an apparent exact 10 AM appointment.

Evidence: `(portal)/bookings/page.tsx:183,408`; `(portal)/overview/page.tsx:472`; `apps/api/app/api/portal/v2/jobs/route.ts:400`.

### JOB-11 — Status and ETA do not keep themselves current (P2, Source)

Overview, job-list and parent job-status/ETA data do not have an automatic visible/focus refresh controller or a clear refresh action. Component-level message/proof changes do not refresh the entire job promise. A partner can remain looking at stale status until navigating or reloading. Provide bounded refresh with a last-updated indicator and an honest degraded state.

Evidence: `(portal)/overview/page.tsx`, `(portal)/bookings/page.tsx`, `(portal)/bookings/[jobId]/page.tsx` rendering/data-loading paths.

### JOB-12 — Job detail does not show the actual photos when photos exist (P2, Source)

Its proof section renders filename/category/status/caption cards rather than usable images. The generic Photos link is offered in the empty case; the populated case lacks a direct job-filtered gallery action. Put viewable proof and a specific gallery link inside the job.

Evidence: `(portal)/bookings/[jobId]/page.tsx:1168,1183,1206`.

### JOB-13 — Saved draft recovery depends on keeping an exact URL (P2, Source)

There is no saved-draft list; returning to a draft starts at step one. Document-exit warnings do not fully guard internal Next navigation before the debounce save runs. Provide a simple “Continue your request” item and safe internal navigation, not a separate template-management product.

Evidence: `PartnerBookingWizard.tsx:663,775,831,839`; `PartnerAppShell.tsx:213`; `apps/api/app/api/portal/v2/booking-drafts/route.ts` exports POST, not a draft-list GET.

### JOB-14 — Bulk intake overstates submission and loses easy access to imported work (P2, Source)

Bulk intake creates drafts, not submitted requests, but calls them saved service requests. Only the first ten row links are shown; up to 100 can be imported. Reload loses in-memory results; corrections downloads do not carry draft IDs; there is no draft browser to recover the rest. Make the outcome unmistakable and recoverable, or hide bulk intake until it is dependable and a real partner needs it.

Evidence: `PartnerRepeatWorkManager.tsx:334,867`; `apps/api/src/lib/partner-repeat-work.ts:2408,2757`.

### JOB-15 — CSV validation queries malformed UUIDs before reporting row errors (P2, Source; database failure not exercised)

`location_id` strings enter a PostgreSQL UUID lookup before UUID validation. The supplied example itself uses `paste-location-uuid`. This ordering can turn a correctable row into a whole-file error. Validate first; use meaningful external site references or explain the required identifier. Replace the hard-coded September 15, 2026 sample date with a relative/example-safe value.

Evidence: `PartnerRepeatWorkManager.tsx:340`; `apps/api/src/lib/partner-repeat-work.ts:2475,2492`.

### JOB-16 — Saved templates cannot be maintained (P2, Source)

Templates can be created and applied, but no edit/rename/archive path was found. Old instructions can accumulate. Prefer straightforward Book again and removable saved shortcuts; do not expand the default screen into template administration.

Evidence: `apps/api/app/api/portal/v2/service-templates/route.ts`; `service-templates/[templateId]/apply/route.ts`; `PartnerRepeatWorkManager.tsx:440`; `PartnerJobActions.tsx:731`.

## 5. Photos, proof, and documents

### PROOF-01 — Switching the selected job retains another job's photos and actions (P1, Reproduced)

The Photos page changes `jobId` on an unkeyed proof component. The component retains proof/files/share state copied only at mount. In Chromium and WebKit, the new Job B heading appeared with A's photo record/caption, and Remove targeted `/jobs/B/proof/A`. The synthetic record had no download URL, so a wrong bitmap was not visually tested. Account/job authorization should reject the mismatched deletion; no successful unauthorized deletion or tenant leak was demonstrated. Reset all job-specific state and handle unsaved uploads explicitly.

Evidence: `(portal)/photos/page.tsx:228`; `PartnerProofWorkspace.tsx:98,345`; actual-component browser reproductions.

### PROOF-02 — An older-job link silently opens a different job (P1, Source)

Photos loads the first 100 jobs, then falls back to the first job if the requested `jobId` is absent. A valid older deep link can therefore show the newest job instead. Resolve the explicit ID independently or show not found; never silently replace an explicitly selected resource.

Evidence: `(portal)/photos/page.tsx:65,103`.

### PROOF-03 — Images/downloads expire without a simple recovery (P2, Source)

Signed links expire in five minutes; lazy images and original downloads have no automatic renewal/error recovery. The public share page tells people to refresh manually. Keep short expiry for security, but renew on use or provide an immediate retry that preserves context.

Evidence: `apps/api/src/lib/partner-portal-v2-media.ts:59,969`; `PartnerProofWorkspace.tsx:674,683,732`; `(public)/proof/[token]/page.tsx:369,512`.

### PROOF-04 — A document requirement cannot be supplied through the partner uploader (P2, Source)

Proof defaults allow Document as a required category, and completion logic counts it. Partner upload categories omit Document and accept images only. Do not let users configure an unexplained requirement they cannot satisfy through that UI. Provide the appropriate supported document path or clearly assign that requirement to staff.

Evidence: `PartnerProofDefaultsManager.tsx:41`; `PartnerProofWorkspace.tsx:566`; `apps/api/src/lib/partner-portal-v2-media.ts:46`; `partner-proof-completion.ts:11,138`.

### PROOF-05 — Deletion is immediate, while recovery is not exposed (P2, Source)

Remove has no confirmation/Undo, and no partner restore endpoint/UI was found despite the recoverable 30-day policy. A soft-deleted row is not the same as usable recovery. Provide Undo or a clear supported staff recovery route; do not introduce destructive retention cleanup.

Evidence: `PartnerProofWorkspace.tsx:345,744`; media deletion routes and 30-day recoverable storage policy.

### PROOF-06 — Getting the completion record is an extra technical operation (P3, Source + Design)

Partners must understand and invoke Create proof package after evidence is present. A simpler Download completion record action should generate/reuse the safe package as appropriate, or staff should prepare it on completion. Keep versions/checksums available under Record details, not as the main task.

Evidence: `PartnerProofWorkspace.tsx:786`; `(public)/proof/[token]/page.tsx:317,496`.

### PROOF-07 — Shared-record times depend on the server timezone (P2, Source)

The public share formatter omits an explicit timezone for completion, capture, generation, and expiry times. A UTC server displays different clock times from Atlanta without explaining the difference. Use the service timezone and label it.

Evidence: `(public)/proof/[token]/page.tsx:230,308,335,347,461`.

## 6. Messages and notifications

### COMMS-01 — Settings advertise updates whose delivery wiring is missing (P1, Source)

Preferences expose ten families, including crew arrival, job completion, payment, messages, proof, and approvals. The inspected partner delivery ledger supports booking create/review/reschedule/cancel and billing-dispute events; other preference keys were found in configuration/tests without corresponding lifecycle consumers. Separate raw in-app event inserts from a fully wired, preference-respecting email/SMS flow. Do not promise notifications merely because the checkbox saves.

Wire the essential request/confirmation/change/message/completion events, or hide unsupported choices. No real-provider email/SMS test was performed.

Evidence: `apps/api/src/lib/partner-notification-preferences.ts:9`; `partner-notification-delivery.ts:81`; delivery ledger preference constraint in `apps/api/src/db/schema.ts:11838`; `PartnerAccountSecurityManager.tsx:70`.

### COMMS-02 — Message navigation and attachments are incomplete (P2, Source)

There is a job-thread API but no accessible all-jobs Inbox page. The message composer always sends `attachmentIds: []`; received attachment metadata is not rendered as usable attachments. A partner should be able to find the latest relevant conversation and send/view a supporting photo without hunting through a separate feature area. A compact recent-messages section may be enough; a new enterprise Inbox is not automatically necessary.

Evidence: `PartnerAppShell.tsx:53`; `PartnerJobMessages.tsx:240`; `apps/api/app/api/portal/v2/jobs/[jobId]/messages/route.ts:281`; `/api/portal/v2/threads`.

### COMMS-03 — Refresh can show old messages instead of the newest reply (P2, Source)

Message history is ascending with a default 50-row page; Refresh requests that first page. Long threads can appear not to receive new replies. There is no automatic message refresh. Load the latest view by default, offer older history separately, and keep visible conversations current.

Evidence: `apps/api/app/api/portal/v2/jobs/[jobId]/messages/route.ts:171,230`; `PartnerJobMessages.tsx:199,360,433`.

### COMMS-04 — Teammates' messages can be labeled as yours (P2, Source)

The component treats every `authorType === "partner"` message as “from you.” The public message DTO lacks the author identity/name required to distinguish colleagues. Show a safe author display name and identify only the current sender as You.

Evidence: `PartnerJobMessages.tsx:718,773`; message DTO projection.

### COMMS-05 — Notification handling hides updates and can block navigation (P2, Source)

Overview shows five unread items without a full history. Mark all read affects more than the visible five. Open prevents navigation unless marking read succeeds. The component also copies initial props once, so a router refresh need not display the next unread items. Navigation should not depend on read-receipt success; synchronize state and clearly distinguish visible-item actions from all-item actions.

Evidence: `(portal)/overview/page.tsx:167`; `PartnerNotificationList.tsx:25,58,62,86,152`.

### COMMS-06 — Operations users cannot verify their own SMS endpoint (P2, Source)

Personal SMS verification requires `account.security.manage`, a capability unavailable to Operations and the other non-admin launch roles. The people coordinating arrival can see notification settings without being able to enable their own verified texts. If SMS remains offered, separate personal verified-phone management from company security administration.

Evidence: `(portal)/settings/page.tsx:147`; `apps/api/src/lib/partner-notification-endpoint-authorization.ts:10`; launch role templates.

### COMMS-07 — Message auto-scroll ignores reduced motion (P3, Source)

The message component uses smooth scrolling without checking reduced-motion preferences. Respect the preference and avoid moving the reader unnecessarily.

Evidence: `PartnerJobMessages.tsx:190`.

## 7. Billing, reporting, and staff completion

### BILL-01 — Reports is offered to roles that the report endpoint rejects (P2, Source)

Operations and Viewer have operational-report capability, which makes Reports appear in navigation. The page loads an endpoint requiring financial-report capability. The resulting denial is a UI/API contract mismatch, not a reason to grant financial access. Provide the right operational view or remove the irrelevant navigation.

Evidence: `lib/portal-context.ts:257`; `apps/api/src/lib/partner-account-authorization.ts:109,156`; `apps/api/app/api/portal/v2/reports/route.ts:8`.

### BILL-02 — Financial history and exports stop early (P2, Source)

Billing displays the first 100 records in each collection without usable next-page controls. Reports similarly shows bounded recent statements. For account-wide statement reports, Download CSV requests no limit/cursor, receives the default first 25 statement periods, and ignores `x-next-cursor`; scoped financial reports instead return currency aggregates. A file labeled simply as the report can therefore be incomplete. Implement complete/explicitly bounded downloads and useful history navigation; do not force users to discover API pagination.

Evidence: `(portal)/billing/page.tsx:170,295,319,343,368`; `(portal)/reports/page.tsx:194`; `PartnerReportExportButton.tsx:14`; `apps/api/src/lib/partner-portal-v2-commercial-route.ts:103`; default pagination.

### BILL-03 — Report totals include draft/void invoices (P1, Source)

The aggregate predicate filters account/scope/currency but not invoice lifecycle. Draft and void records are summed into the amounts presented as invoiced/paid/balance. Define correct issued/accounting-state totals and exclude or separately label records that should not count. No claim is made that existing partners were overcharged; the live portal has no configured partners.

Evidence: `apps/api/src/lib/partner-portal-v2-commercial.ts:63,829`.

### BILL-04 — Claimed report breadth is not implemented in the partner screen (P2 completeness, Source)

The page is a financial summary/statement listing, not the older promised report tool with date/location/service/requester/PO/proof filters and PDF output. For the new goal, do not automatically build every old reporting idea. Make My jobs/history useful and provide the specific invoice/export functions actual partners need.

Evidence: `(portal)/reports/page.tsx`; `PartnerReportExportButton.tsx`; historical audit's open commercial/reporting scope.

### BILL-05 — Some empty-state actions ignore the user's permissions (P2, Source)

Reports and Photos can offer Request service to Billing/Viewer roles that cannot create jobs. Match each suggested next action to the current user's allowed tasks. Keep explanations plain and provide Sales support rather than another denial page.

Evidence: `(portal)/reports/page.tsx:79`; `(portal)/photos/page.tsx` empty-state actions; launch roles and booking page permission gate.

### STAFF-01 — Team-access loading failures look like empty lists (P2, Source)

Invitation/join failures are replaced with empty arrays without warning, so an administrator can think there are no pending items when those data sources failed. Preserve an explicit unavailable state and retry independently.

Evidence: `(portal)/settings/team/page.tsx:46,139`.

### STAFF-02 — Partner administration is not the simple staff-led relationship flow the new product needs (P2, Design + Source)

Staff tooling has many separate areas for accounts, domains, people, memberships, invitations, joins, security, reconciliation and commercial configuration. Partner admins can change roles but cannot set location/cost-center restrictions in their invitation/member UI, while staff has richer scope controls. Keep safe advanced controls internally, but build a clear company-centered path: select the known relationship, verify contact, enable relevant service defaults, invite person, see whether they activated, help them book.

Evidence: `apps/site/src/app/team/components/PartnerAdministrationSection.tsx` section definitions; `PartnerInvitationManager.tsx:111`; `PartnerTeamManager.tsx:213`.

### STAFF-03 — Staff commercial execution is still incomplete (P1 for offering full billing, Source + Unverified)

The staff Commercial surface explicitly says pricing/invoices remain read-only there and billing-policy/provider configuration still needs canonical writers. Agreement and approval-rule editors plus quote links do not establish complete invoice issuance, monthly statements, refunds, or reconciliation. Partner-facing payment pages are not proof that the staff-side billing work can be completed.

Keep invoice/pay/download only where the full workflow is configured and tested; otherwise offer the actual staff-assisted service rather than an unfinished software promise.

Evidence: `PartnerAdministrationSection.tsx:3845`; historical `partner-portal-audit.md` Explicit GA blockers; provider-neutral payment and commercial services.

## 8. Missing verification, not automatically missing features

The audit did not execute a real partner journey from invitation to password setup, request, staff confirmation/completion, proof delivery, invoice/payment, and records. There are no configured live partners to use for that journey, and an audit does not authorize creating production jobs or payments.

The following remain unverified now:

- Production-equivalent cross-channel scheduling races and real Google/Mapbox failure behavior.
- Real private-storage upload/finalization, HEIC conversion, interruptions, signed-link expiry recovery, and document handling.
- Actual email/SMS lifecycle delivery, consent/quiet hours, inbound replies and ambiguous-context reconciliation.
- Square hosted/embedded checkout, ACH settlement, duplicate/out-of-order webhooks, refunds, and invoice/statement reconciliation.
- Staff invoice issuance, completion-package preparation, incident/recovery routines, and relationship onboarding readiness.
- Full authenticated Next.js navigation across all roles, screen readers, actual phones, and native browser zoom.
- Partner task completion time, comprehension, and field performance. No lab Core Web Vitals result is claimed.

The existing no-JavaScript landing test checks headings/links, not actual credential/access form behavior (`tests/e2e/audit/partner-portal-quality.spec.ts:185`). The present passing source/contract suites missed the reproduced cross-page state defects. Add journey tests for changing resources without remounting, more than one page of data, role-denied actions, saved-draft recovery, and failed hydration.

The historical 99-row audit itself still says not ready for general availability. Its implementation and earlier test counts are historical evidence, not proof these current workflows all work.

## What should stay

- One safe company/account boundary and correctly limited access to jobs and billing.
- Ordinary email/password sign-in, safe reset/activation links, session expiry/revocation, and protected location secrets.
- Clear separation between a confirmed arrival window and a request awaiting Stonegate confirmation.
- Capacity checks, holds, revision checks, duplicate-submission protection, and review when a dependency is uncertain.
- Saved sites, request description, optional photos, access instructions and on-site contacts.
- Job-level status, messages, proof, documents, cancellation/change requests, and Book again.
- Service invoices and appropriate approval workflows for partners that actually require them.
- Accessible labels/focus/skip links, mobile drawer behavior, reduced-motion support, and privacy-safe operational analytics.
- Explicitly non-live sample data where a demonstration remains, though it need not occupy the entrance.

Simplification should remove work from the partner, not remove safety checks or destroy useful historical records.

## Recommended direction and order

### 1. Establish the simple relationship entrance

Replace the feature pitch/public application promotion with a short welcome for existing Stonegate partners. Show Sign in immediately. For new access, missing invitations, password trouble, unavailable service, or questions, show the existing Sales email and phone. Staff should handle the relationship/access decision.

### 2. Fix wrong-resource and unsafe-form bugs before inviting partners

Correct password fallback, draft switching, proof switching, explicit older-job selection, and invitation-role selection. Add browser regression tests reproducing the failures described above. Keep API authorization and capacity controls intact.

### 3. Make the basic service request actually quick

Open directly on the form. Select a saved location, carry over its safe defaults, enter the work/photos, choose a date/window, and send. Put less-common details behind relevant optional sections. Keep the request resumable and make review-only scheduling/rescheduling genuinely work.

### 4. Make each job the useful single place to return

Show the complete arrival window, correct contact, current status, conversation, photos, completion record, and relevant bill together. Provide Book again and clear change/help actions. Keep a small My jobs list with dependable filters/history.

### 5. Configure and prove the real operation

Set up a Stonegate-owned relationship/account with its real service policy, pricing/review expectations, locations, schedule dependencies and delivery configuration. Perform controlled end-to-end acceptance without sending unintended partner notifications or charging real customers. Enable only proven workflows. Do not turn every production flag on as a substitute for this step.

### 6. Keep advanced tools optional

Only expose recurring work, bulk intake, team administration, approval systems or reports when a real partner needs them and their workflow is complete. Existing functionality can be moved or hidden; it does not all need deletion or expansion.

### Simple acceptance test

An existing partner should be able to answer these questions without an explanation of the software:

1. Where do I sign in, and whom do I contact if I cannot?
2. How do I request service at my saved location?
3. Is my time confirmed or am I waiting for Stonegate?
4. Where can I see the latest update, send a question, and view the photos?
5. How do I request the same service again or change this request?

If a page does not help with those tasks or a real account-specific business requirement, it should not compete in the main partner experience.

## Implementation-reference notation

Unless a full path is written, partner page paths such as `(portal)/book/page.tsx`, component names such as `PartnerBookingWizard.tsx`, and `lib/...` refer respectively to `apps/site/src/app/partners/`, `apps/site/src/app/partners/components/`, and `apps/site/src/app/partners/lib/` at the baseline commit. Line references indicate the relevant block, not a claim that a single line proves an entire multi-file behavior.

The sections below the implementation ledger preserve the original audit. The ledger tracks subsequent remediation; neither the original audit nor local test results constitute release approval.
