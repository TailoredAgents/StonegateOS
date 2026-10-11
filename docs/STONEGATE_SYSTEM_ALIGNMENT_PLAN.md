# StonegateOS System Alignment and Demo Readiness Plan

> This is the canonical coordination plan for safely aligning StonegateOS while it remains in daily production use. It governs the order of work, operational safeguards, desktop/mobile responsibilities, documentation cleanup, productization, demo readiness, and later visual polish.

## Program status

| Field             | Current value                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Current phase     | Phase 0 live evidence in parallel with Phase 2 desktop foundation                                            |
| Program status    | Phase 1 repository gate complete on Node 20; production certification remains held by open Phase 0 evidence  |
| Last updated      | 2026-10-10                                                                                                   |
| Live-system rule  | Preserve existing operational data and workflows; no reset or destructive cleanup                            |
| Mobile rule       | Jeffrey's mobile workflows are behavior-protected; no material redesign without explicit review and approval |
| Desktop direction | Bring the office experience up to operational parity without forcing phone layouts onto desktop              |
| Demo direction    | Use the real product with sanitized, controlled demo data and rehearsed provider behavior                    |
| Next checkpoint   | Capture protected Mobile and desktop baselines for the human usability and aesthetic review                  |

## Mission

StonegateOS already runs Stonegate Junk Removal's daily operation. The objective is not to rebuild it. The objective is to evolve the working system into a coherent, well-documented, confidently demonstrable product without disrupting the business.

The finished product should communicate one connected operating loop:

```text
Public booking
  -> office inbox and CRM
  -> quote
  -> scheduling and dispatch
  -> mobile crew execution
  -> photos, payment, expenses, and completion
  -> owner review and reporting
```

## Product direction

Alignment does not mean making desktop and mobile identical.

- `/team` is the office operations command center for CRM, inbox, quoting, planning, reporting, approvals, configuration, and administration.
- `/mobile` is the protected field application for today's work, directions, customer contact, scope, photos, payments, completion, expenses, and bad-signal recovery.
- Both experiences must share business rules, permissions, statuses, terminology, branding, and data contracts.
- Each experience may retain a layout and interaction model appropriate to its users.
- The mobile implementation is the reference for established field workflows. Desktop should adopt its operational truth without redesigning the mobile experience.
- The supported desktop product is `/team`. The experimental `apps/app` Owner Hub is not part of the prospect demo or target product architecture.

## Non-negotiable safety contract

The following rules apply throughout every phase:

1. Do not reset, reseed, truncate, or replace the production database.
2. Do not delete or bulk-rewrite operational records as part of UI, documentation, parity, or demo work.
3. Inspect first with read-only checks. Record the current behavior before changing it.
4. Prefer additive and backwards-compatible schema changes. Use forward fixes rather than destructive rollbacks.
5. Separate schema rollout, code rollout, data backfill, and old-path retirement when risk warrants it.
6. Put material workflow changes behind a feature flag or another reversible release control.
7. Define the rollback procedure before deploying a production-affecting change.
8. Use controlled test identities and sanitized records. Do not expose real customer information during a prospect demo.
9. Do not trigger real customer messages, calls, payments, or provider actions during testing unless the exact controlled action is explicitly approved.
10. Release in small, independently verifiable increments outside peak operating periods when practical.
11. Preserve unrelated worktree changes and existing operational configuration.
12. Do not mark a phase complete from source inspection alone when its gate requires runtime, production, visual, accessibility, provider, or staff evidence.

## Mobile stability contract

Jeffrey's investment in the mobile application is protected throughout this program.

- Do not restructure mobile navigation or reorder established workflows without his review.
- Do not replace familiar job, photo, payment, completion, expense, or offline-recovery interactions merely to match desktop.
- Do not materially change touch targets, labels used by crews, or successful field sequences without before-and-after evidence and approval.
- Capture approved baselines at 320 px and 375 px for critical screens and states.
- Add or preserve regression coverage for login, My Day, Inbox, Contacts, booking cards, job details, scope, photos, payments, completion, expenses, and offline recovery.
- Mobile changes during desktop-parity phases should normally be limited to shared bug fixes, security, accessibility, or explicitly approved consistency work.
- When shared logic is extracted, prove that mobile output and behavior remain equivalent before releasing it.

## Evidence and change protocol

### At the start of each phase

- Confirm the current production and repository revisions.
- Review this plan and the phase acceptance gate.
- Inspect `git status` and preserve unrelated changes.
- Identify affected data, permissions, integrations, and provider side effects.
- Define the test accounts, test records, feature flag, and rollback path.
- Split the phase into small changes that can be reviewed and reversed independently.

### Before a production deployment

- Pass the checks proportional to the changed behavior.
- Review migrations for destructive or locking behavior.
- Verify environment variables and feature flags across Site, API, and workers.
- Confirm that no production credentials or customer data appear in test artifacts.
- Obtain explicit operational approval for the deployment window.

### After a production deployment

- Verify health and readiness.
- Run the relevant controlled smoke journey.
- Check logs, workers, provider results, and customer-facing output.
- Confirm that unchanged mobile and desktop critical paths still work.
- Record the revision, evidence, exceptions, and rollback outcome in a dated release audit.
- Update this plan before beginning the next phase.

## Status notation

- `[x]` complete with evidence
- `[~]` in progress
- `[ ]` not started
- `[!]` blocked or requires an explicit decision

## Phase 0 — Production baseline and safety contract

### Objective

Create a trustworthy baseline before changing live behavior.

### Work

- [x] Complete a source-based desktop/mobile capability and documentation audit.
- [x] Establish the mobile stability contract and desktop catch-up direction.
- [x] Confirm that the initial audit was read-only and left the worktree clean.
- [ ] Record the currently deployed Site, API, and worker revisions.
- [ ] Inventory the effective production feature flags and provider enablement without exposing secrets.
- [ ] Verify backup, restore, and Render rollback procedures with evidence appropriate to the live system.
- [x] Create a current capability matrix covering public, Team, Mobile, Partner, API, worker, permission, and test ownership.
- [ ] Capture mobile visual and behavioral baselines at supported phone widths.
- [ ] Capture desktop visual and behavioral baselines for the prospect journey.
- [~] Define the sanitized demo-data boundary; actual identities and records still require operational coordination.
- [ ] Record peak operating periods and approved release windows.
- [x] Create a risk register for database, authentication, notifications, payments, AI, media, and background-worker changes.

### Gate

Phase 0 is complete when current production behavior, revisions, safety controls, demo-data boundaries, rollback procedures, and protected mobile baselines are recorded without modifying operational data.

## Phase 1 — Documentation truth and release confidence

### Objective

Make the repository's documentation and automated evidence accurately describe the system that exists.

### Work

- [x] Create one current system overview covering `/team`, `/mobile`, public booking, Partner Portal, API, workers, integrations, and deployment topology.
- [x] Create the desktop/mobile capability matrix and identify intentional differences separately from parity defects.
- [~] Reconcile the stale Team remediation verdict with current code; fresh authenticated runtime evidence remains open.
- [x] Reconcile and label the stale Mobile App Plan against completed mobile booking, completion, Spend, media, and offline work.
- [x] Generate the API route, schema, and literal event indexes from code and add a drift check. Permission ownership is summarized in the capability matrix and API catalog.
- [x] Update the root and application READMEs to describe current routes, supported applications, commands, and provider integrations.
- [x] Correct the Render deployment guide, including migration-target requirements and rollback behavior.
- [x] Expand the release checklist to cover Mobile, Quote V2, Spend V2, appointment media, Square, and modern Partner journeys.
- [x] Mark superseded plans and audits as historical while preserving them for traceability.
- [x] Repair the general Jest/ESM runner and its exposed contract/mock debt; all 469 enabled suites and 4,739 enabled tests pass on Node 20.
- [x] Add the full Team Console audit to the blocking general workflow while preserving final failure enforcement.
- [x] Produce a dated local release-readiness report tied to the exact repository baseline; deployed-revision evidence remains tracked separately in Phase 0.

### Gate

Phase 1 is complete when a developer can start from `docs/README.md`, identify the current architecture and product status, run the documented checks, and reach evidence that agrees with the code and deployed system.

Repository gate status: complete on 2026-10-10. Agreement with the deployed system is not yet certified and remains an explicit Phase 0 production-evidence dependency; this distinction permits read-only and low-risk Phase 2 work without implying deployment approval.

## Phase 2 — Desktop foundation and cross-product consistency

### Objective

Make `/team` feel like the office half of the same product without disturbing mobile workflows.

### Work

- [x] Establish canonical customer, contact, property, booking, appointment, job, quote, Spend/expense, payment/payout, Partner, and status terminology.
- [~] Align desktop labels and help text with established operational language; the contract is recorded and surface rollout remains.
- [x] Define shared brand, typography, neutral-surface, accent, status, focus, spacing, and Team navigation tokens.
- [~] Apply low-risk consistency improvements to `/team` first; shell tokens, Partner cleanup, critical control labels, target sizes, keyboard table access, automated contrast remediation, and the first Calendar/Contacts/Expenses/Partner semantic surface batch are complete.
- [x] Make Quotes and Partners handoffs preserve context and provide predictable back navigation; validated internal origins now survive Quote mode/retry/completion flows and Partner administration/company/preview/scheduling flows.
- [x] Verify `/team` at desktop, tablet, and narrow responsive widths; the final clean-room matrix passed 232 checks with 8 intentional skips and zero failures/flakes across 1440/1024/768/375/320 in both themes.
- [x] Audit apparently superseded desktop components before proposing removal; classic Team remains a tested, user-reachable compatibility shell over the same canonical workspaces, non-use is not proven, and no retirement or deletion is authorized.
- [ ] Preserve mobile screenshots and interaction baselines throughout the phase.

### Gate

Phase 2 is complete when desktop navigation, naming, status presentation, and route transitions feel intentionally related to mobile, with no material mobile workflow change or operational regression.

## Phase 3 — Desktop field-job workspace

### Objective

Give office users complete visibility and appropriate control over the field job lifecycle.

### Work

- [ ] Define a shared job-workspace contract using the existing appointment feed and mobile behavior.
- [ ] Add quoted scope, service details, job notes, customer/property context, and crew assignments to the desktop appointment detail.
- [ ] Add photo/media visibility, proof requirements, upload state, and recovery indicators.
- [ ] Add payment status, method, amount, history, and permission-appropriate collection or correction actions.
- [ ] Add call, message, and directions actions appropriate to desktop.
- [ ] Add completion state, missing-proof explanation, retry state, and audit history.
- [ ] Enforce the same underlying permissions and status transitions across desktop and mobile.
- [ ] Release read-only visibility before higher-risk write actions when practical.
- [ ] Place new write actions behind reversible controls until verified.
- [ ] Add desktop E2E coverage corresponding to the protected mobile job journeys.

### Gate

Phase 3 is complete when office staff can understand and support a job from quote through completion without switching to the mobile route, while crews experience no regression in their existing workflow.

## Phase 4 — Desktop Spend V2 and permission alignment

### Objective

Provide a coherent expense workflow for crew submitters, office reviewers, and owners.

### Work

- [ ] Define one permission model for expense read, submit, approve, reject, export, and administer actions.
- [ ] Correct desktop access so authorized crew submitters are not excluded by unrelated approval permissions.
- [ ] Add desktop receipt viewing and upload, expense submission, categories, job association, and truthful processing states.
- [ ] Add approval, rejection, duplicate review, dump-ticket, fixed-cost, and ad-spend tools for authorized roles.
- [ ] Reuse API contracts and validation rules already proven by Mobile Spend V2.
- [ ] Preserve mobile capture, scanning, offline queueing, and retry behavior.
- [ ] Add role-based desktop/mobile contract and E2E tests.
- [ ] Validate exports and financial totals without altering historical expense records.

### Gate

Phase 4 is complete when each role can perform its intended expense work on the appropriate device, both interfaces show the same records and statuses, and historical financial data remains unchanged.

## Phase 5 — Company configuration and safe productization

### Objective

Make another-company deployment a controlled configuration exercise instead of an undocumented code fork.

### Work

- [ ] Inventory Stonegate-specific identity, phone, email, domain, service-area, pricing, notification, prompt, document, and staff assumptions in production paths.
- [ ] Classify each value as public build-time configuration, protected runtime configuration, Policy Center data, Company Pack data, or intentionally custom code.
- [ ] Remove customer-facing hardcodes from notifications, documents, partner surfaces, quotes, and supported application shells.
- [ ] Complete and validate the Company Pack import/export path in a disposable environment.
- [ ] Decide and document whether new companies receive isolated deployments or a future multi-tenant architecture; do not imply multi-tenancy before it exists.
- [ ] Replace or clearly exclude placeholder public assets.
- [ ] Retire legacy break-glass access only after individual-account access, recovery, and operational fallback are proven.
- [ ] Formally exclude or safely retire `apps/app` after proving it has no production responsibility.
- [ ] Run a new-company launch rehearsal in an isolated environment using only the documented procedure.

### Gate

Phase 5 is complete when a second company can be configured in an isolated deployment without Stonegate customer-facing leakage, undocumented manual database edits, or loss of access controls.

## Phase 6 — Prospect demo environment and operating story

### Objective

Demonstrate the real, currently used product without exposing or endangering live operations.

### Work

- [ ] Create a sanitized demo workspace, deployment, or tightly controlled demo account using realistic junk-removal data.
- [ ] Ensure demo records cannot contact real customers, charge real payment methods, or pollute operational reporting.
- [ ] Seed a coherent customer, property, conversation, quote, booking, job, media, payment, expense, and partner story.
- [ ] Verify Quote V2, Square, AI, notifications, media, and provider flags in the exact demo environment.
- [ ] Prepare a rehearsed desktop-to-mobile narrative with named checkpoints and recovery options.
- [ ] Prepare truthful answers about deployment model, configuration, security, support, and roadmap.
- [ ] Create a pre-demo checklist and a post-demo cleanup procedure.
- [ ] Run the complete demo at least once against the exact environment and revision that will be shown.

### Recommended demo sequence

1. Public quote or booking.
2. Lead appears in Team Inbox.
3. Office opens the Contact and property context.
4. Office creates and sends Quote V2.
5. Dispatcher schedules the job in Calendar.
6. Crew opens the job in Mobile, reviews scope, uses directions, records photos, handles payment, and completes the work.
7. Office sees the completed job, proof, payment, expense, and owner-level result.
8. Show Partner Portal only when it is relevant to the prospect's commercial or property-management work.

### Gate

Phase 6 is complete when the prospect story can be completed repeatedly without real-customer exposure, uncontrolled external effects, unexplained shell changes, or dependence on unverified live providers.

## Phase 7 — Visual audit and professional polish

### Objective

Improve perceived quality after functionality, documentation, and demo behavior are stable.

### Work

- [ ] Capture every important page at agreed desktop and mobile widths using representative data.
- [ ] Score each surface from 1–100 using visual hierarchy, color balance, typography, spacing, density, navigation clarity, component consistency, accessibility, continuity, and prospect impact.
- [ ] Prioritize the lowest-scoring and most frequently demonstrated surfaces.
- [ ] Reduce excessive same-color treatment by defining deliberate background, raised-surface, border, interactive, accent, and status layers.
- [ ] Improve hierarchy through spacing, typography, grouping, emphasis, and restrained color rather than decorative complexity.
- [ ] Verify contrast, focus, zoom, reduced motion, touch size, empty states, loading states, and error states.
- [ ] Apply desktop polish first where possible.
- [ ] Require Jeffrey's review for material mobile-facing visual changes.
- [ ] Preserve approved before-and-after screenshots as visual regression baselines.

### Gate

Phase 7 is complete when critical prospect and daily-use surfaces meet the agreed visual score, accessibility checks pass, and the product feels intentionally unified without disrupting familiar mobile operation.

## Phase 8 — Certification and ongoing maintenance

### Objective

Turn the completed alignment work into a repeatable operating discipline.

### Work

- [ ] Run the full release matrix against an exact commit and production-like environment.
- [ ] Verify desktop and mobile role, permission, viewport, provider, recovery, and critical-journey coverage.
- [ ] Complete controlled staff acceptance with office and field users.
- [ ] Publish the final readiness report, capability matrix, known limitations, and supported deployment model.
- [ ] Establish ownership and review dates for canonical documentation.
- [ ] Make generated documentation drift checks part of CI.
- [ ] Schedule periodic desktop/mobile parity and visual reviews.
- [ ] Require each future feature to declare desktop, mobile, API, permission, documentation, test, and rollout impact.

### Gate

The program is complete when Stonegate can use the system daily, demonstrate it safely, configure it honestly for another company, and rely on current documentation and repeatable release evidence without sacrificing the protected mobile workflow.

## Overall definition of done

- [ ] No production records were reset, discarded, or silently rewritten by this program.
- [ ] Mobile field workflows remain familiar, stable, and approved by their daily users.
- [ ] Desktop provides the job-execution and Spend visibility/actions office users need.
- [ ] Desktop and mobile share terminology, permissions, statuses, branding, and operational truth.
- [ ] Current documentation agrees with code, deployment configuration, and verified runtime behavior.
- [ ] The general quality pipeline reaches and passes its build and browser stages.
- [ ] The full Team audit is part of the release evidence.
- [ ] Another-company configuration has been rehearsed without Stonegate customer-facing leakage.
- [ ] A sanitized, repeatable prospect demo completes the full office-to-field story.
- [ ] Critical surfaces meet the agreed visual and accessibility standard.
- [ ] Rollback, recovery, monitoring, and documentation maintenance have named procedures and owners.

## Documentation ownership model

| Document                     | Responsibility                                                           |
| ---------------------------- | ------------------------------------------------------------------------ |
| This plan                    | Program order, status, safety rules, phase gates, and next action        |
| `CURRENT_SYSTEM_OVERVIEW.md` | Current architecture and product topology after Phase 1 reconciliation   |
| `CAPABILITY_MATRIX.md`       | Current feature, surface, permission, flag, and test ownership           |
| `RELEASE_CHECKLIST.md`       | Required checks for live deployment                                      |
| Runbooks                     | Operational procedures for specific integrations and high-risk workflows |
| Dated release audits         | Immutable evidence for a particular commit and deployment                |
| Historical plans/audits      | Context only; clearly labeled as superseded when no longer current       |

## Decision log

| Date       | Decision                                                                          | Reason                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | Preserve `/mobile` as the protected field-work reference                          | It is heavily used, contains mature field workflows, and represents substantial Jeffrey-led development                         |
| 2026-10-10 | Bring `/team` up to parity instead of redesigning mobile                          | Desktop has been comparatively neglected and is the more visible gap in an office-led prospect demonstration                    |
| 2026-10-10 | Keep desktop and mobile purpose-built rather than pixel-identical                 | Office and field users have different interaction needs, while still requiring shared operational truth                         |
| 2026-10-10 | Defer broad aesthetic redesign until after functional and documentation alignment | Visual work is safer and more durable once screens, workflows, and terminology are stable                                       |
| 2026-10-10 | Use sanitized demo data with the real product                                     | This supports an honest demonstration without exposing customers or risking daily operations                                    |
| 2026-10-10 | Preserve Mobile “Spend” and desktop “Expenses” as purpose-specific terms          | Mobile is field capture; desktop is the financial ledger. Shared record truth matters more than identical labels                |
| 2026-10-10 | Centralize Team shell states in semantic light/dark tokens                        | It reduces visual drift without changing routes, permissions, data, or Mobile behavior                                          |
| 2026-10-10 | Fix the E2E Compose project name to `stonegateos-e2e`                             | A generic `devops` project name could target unrelated local containers during destructive test cleanup                         |
| 2026-10-10 | Treat automated WCAG failures as desktop-foundation defects                       | Missing names, keyboard access, target size, and contrast weaken daily use and prospect confidence                              |
| 2026-10-10 | Keep the complete ten-project Team WCAG matrix as the permanent gate              | It catches width/theme interactions that the original desktop-light and phone-dark smoke pair could not see                     |
| 2026-10-10 | Carry nested Team origins only through validated Quote and Partner return state   | It restores predictable back navigation without introducing external redirects, self-loops, permission changes, or Mobile churn |

## Immediate next action

Capture protected Mobile and desktop screenshot baselines for the human usability/aesthetic review. The classic Team audit confirms it is still a tested, user-reachable compatibility shell over the same canonical workspaces, so no retirement or deletion is authorized without privacy-safe usage evidence, staff sign-off, and the documented notice period. The first prospect-visible semantic batch now covers Calendar controls/filters/empty state, Contacts list/detail surfaces, the Expenses form/summary/ledger, and Partner access/scheduling entry surfaces. Preserve existing routes, permissions, operational data, domain-status colors, and Mobile behavior. In parallel, close Phase 0 through read-only revision/flag/recovery evidence; do not deploy production-affecting parity or broad visual changes until those controls and the sanitized demo boundary are approved.
