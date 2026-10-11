# System Alignment Phase 2 Desktop Foundation Audit — 2026-10-10

> Source-based desktop/mobile alignment evidence and the working contract for Phase 2. This audit does not certify the live deployment or replace the later screenshot-based visual review.

## Evidence boundary

| Field                            | Value                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Repository baseline              | `main` at `c2e09ea8`, plus the active alignment worktree                            |
| Surfaces reviewed                | `/team`, `/mobile`, Partner staff handoffs, shared Site theme, Team audit coverage  |
| Production data changed          | No                                                                                  |
| Database commands run            | Migrations and deterministic seed only against a named disposable local E2E volume  |
| Provider actions triggered       | None                                                                                |
| Mobile behavior changed          | No material change; one redirect now uses a helper but still emits `/team/partners` |
| Signed-in production screenshots | Not available; local authenticated audit evidence is recorded below                 |

## Executive verdict

Desktop is not broadly behind Mobile. It is ahead in office planning, CRM depth, financial oversight, Partner administration, sales, marketing, policy, and access administration. The lag is concentrated in two high-impact operational areas:

1. Desktop appointment detail does not yet expose the full Mobile field-job context, proof, payment, completion, and recovery story.
2. Desktop Expenses is a financial ledger and approval surface, not an equivalent to the Mobile Spend V2 capture and crew-submit workflow.

That makes the functional parity gap **moderate and concentrated**, while the prospect-demo gap remains **high** until an office user can follow a job from quote through field completion without the product story breaking across surfaces.

The immediate presentation problem is consistency debt rather than missing breadth. The Team source currently contains 241 TypeScript/TSX files and 142 component files. Of those component files, 74 import the shared `team-ui` helpers, while 104 still contain at least one direct palette utility. Direct color use is sometimes legitimate for charts and status meaning, but the volume explains why adjacent desktop screens can feel like different generations of the product.

## Capability position

| Area                                        | Desktop position relative to Mobile                           | Phase ownership                                  |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| Inbox and customer communication            | At parity or ahead                                            | Preserve; consistency polish only                |
| Contacts, properties, and CRM context       | Ahead                                                         | Preserve; normalize labels and headers           |
| Calendar and office planning                | Ahead for planning; behind for field-job execution            | Phase 2 shell consistency, Phase 3 job workspace |
| Quotes                                      | Strong but deployment-flag dependent                          | Phase 2 handoff consistency                      |
| Spend and expenses                          | Behind for capture/crew submission; ahead for ledger/export   | Phase 4                                          |
| Owner and financial oversight               | Ahead                                                         | Preserve                                         |
| Partner staff operations                    | Broad and strong; navigation density and handoffs need polish | Phase 2                                          |
| Sales, marketing, policy, access, and audit | Desktop-owned by design                                       | Preserve; semantic-token rollout                 |

## Canonical terminology contract

Desktop and Mobile should share meaning without erasing device-specific language that users already understand.

| Canonical term  | Meaning                                             | UI rule                                                                      |
| --------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Customer        | The person or organization receiving service        | Use in customer-facing and plain-language workflow copy                      |
| Contact         | The CRM record for a person                         | Use for record navigation, search, merge, and administration                 |
| Property        | A saved service location and its access context     | Do not use “customer” when the action affects only the location              |
| Booking         | The request or creation workflow that reserves work | Use for intake and scheduling handoffs, not as the universal job noun        |
| Appointment     | The scheduled visit/time block                      | Use for calendar state and schedule mutations                                |
| Job             | The operational work being executed                 | Use for scope, crew, proof, payment, completion, and recovery                |
| Quote           | A priced proposal                                   | Keep “Instant quote” as the distinct automated-intake subtype                |
| Spend           | The field capture workflow familiar to Mobile users | Preserve on Mobile; do not rename Jeffrey's workflow merely to match desktop |
| Expense         | A financial ledger record                           | Preserve for desktop accounting, review, correction, export, and reporting   |
| Payment         | Money collected from a customer                     | Never use for a crew or Partner disbursement                                 |
| Payout          | Money disbursed to a crew member or Partner         | Never use as a synonym for customer payment                                  |
| Team member     | An authenticated staff identity                     | Use “crew” only for the field role/group, not every user                     |
| Partner company | The external commercial account                     | Use “Partner” for the product area and “company” for a specific account      |

Machine statuses remain stable API values. UI copy should humanize them consistently, retain the underlying value for audit/debug evidence, and never invent a more advanced state than the record actually has.

## Desktop design-system contract

- Global brand, typography, spacing, radii, and base colors come from `packages/ui/src/theme/tokens.ts`.
- Team light/dark semantic variables live in `apps/site/src/app/globals.css`.
- Reusable Team cards, inputs, buttons, state panels, focus rings, and empty states live in `apps/site/src/app/team/components/team-ui.ts`.
- Status colors communicate meaning: info, success, warning, and danger. They are not alternate decoration palettes.
- Product navigation uses semantic active, border, text, icon, shadow, hover, and focus tokens so light/dark behavior can be tuned once.
- Direct palette utilities remain acceptable for bounded data visualization or domain-specific status meaning, but ordinary shells, cards, filters, and controls should migrate to semantic helpers.
- Phase 2 improves structure and consistency. The later screenshot review owns broad color reduction, aesthetic scoring, and brand polish.

## First low-risk consistency batch

Completed without touching Mobile, routes, permissions, data, or business mutations:

- Added theme-aware semantic tokens for Team navigation active state, icon, border, shadow, hover border, and focus presentation.
- Migrated the modern Team shell navigation away from direct `primary-*` active/focus styling.
- Preserved light/dark theme behavior while improving dark-shell contrast control.
- Removed all nine Site lint warnings from desktop Partner components by stabilizing effect callbacks, cleanup invalidation, and access-scoped image intent.
- Added a source contract that prevents the shell navigation from drifting back to direct palette classes.

## Second low-risk handoff batch

Completed without changing route outputs, permissions, data, or workflow behavior:

- Added canonical Partner administration and scheduling URL builders and adopted them across Team Partner navigation, request review, services, portal operations, and company settings handoffs.
- Removed a stale invalid `p_admin=companies` company-settings link by routing through the supported Partner company helper.
- Adopted the existing Quote workspace builder for create/manage transitions instead of hand-built query strings.
- Replaced one Mobile redirect expression with `teamSurfaceHref("partners")`; the emitted destination remains exactly `/team/partners`.
- Added route-builder and source-contract coverage for the canonical handoffs.

## Nested return-state completion batch

Completed without changing Mobile, permissions, APIs, database state, provider behavior, or business mutations:

- Added validated `quote_return` and `p_return` navigation hints. Both accept only credential-free internal `/team` destinations and reject external or protocol-relative URLs, hashes, authentication routes, encoded path separators, overlong input, and workspace self-loops.
- Preserved the exact Contacts or Pipeline origin when opening Quote creation, and the exact Partner commercial context when opening an account-bound Quote.
- Preserved Quote context and origin across create/manage/instant mode changes, load retries, Instant Quote conversion, and Quote V2 completion links.
- Preserved Contact origin through Partner administration, company sections, filters, paging, read-only portal preview, and scheduling-resource navigation.
- Added a consistent “Back to previous workspace” action only after server-side validation; authorization remains the responsibility of the destination surface.
- Added hostile-input, smuggled-parameter, canonical-encoding, and self-loop tests for both builders.

## Prospect-visible semantic surface batch

Completed without changing Mobile, routes, permissions, APIs, database state, provider behavior, or business mutations:

- Migrated Calendar period/view controls, filters, filter reset, and the empty state to the shared Team button, input, text, and empty-state helpers.
- Migrated ordinary Contacts list/detail cards, table presentation, back actions, and empty states to semantic Team surfaces while leaving customer and workflow behavior unchanged.
- Migrated the Expenses add form, summaries, ledger, filters, pagination, and ordinary record cards to semantic Team inputs, buttons, borders, text, and surfaces.
- Migrated Partner access and scheduling entry surfaces to the same semantic shell and shared button treatments.
- Retained direct palette colors where they communicate calendar events, status, risk, or another domain meaning; broad color reduction remains a screenshot-review decision.

## Classic Team compatibility ownership

The classic path is not a second set of business workspaces. `page.tsx` selects the same permission-filtered surface registry, lazy loaders, and rendered workspace content for both layouts; `layout=classic` changes the surrounding navigation and shell. The modern account/settings controls still expose a deliberate “Classic layout” action, classic navigation preserves the layout parameter, and the classic shell shows a supported compatibility notice plus a route back to the canonical modern surface.

Non-use cannot be proven from the repository. There is no privacy-safe layout-usage threshold evidence, the switch remains user-reachable, and the existing retirement contract requires 30 days below one-percent use, parity, staff sign-off, and two notices. The classic branch therefore remains a production compatibility responsibility. Its source contract and browser checks stay in the gate; no component, route, switch, or query compatibility was removed or redirected.

## Isolated browser audit and remediation batch

The first safe browser run uncovered two harness defects before UI evidence could be trusted:

1. `scripts/e2e-compose.ts` inherited the generic Compose project name `devops`. A running container from an unrelated older checkout used that same name, so the documented `down --volumes` command could have removed unrelated local data. The runner now fixes the project name to `stonegateos-e2e`.
2. The Partner fixture inserted invoice lines after setting `issued_at`, conflicting with the current immutable-issued-invoice rule. The fixture now creates a draft, inserts its line, and then transitions to the intended issued/paid/overdue state.

The audit was then run on unused Site/API ports against the named disposable PostgreSQL volume and loopback provider fakes. The unrelated `devops-postgres-1` container remained running and unchanged. The disposable stack, its volume, the temporary Site/API servers, and generated E2E env copies were removed after verification.

The initial accessibility inventory produced 32 passes and 16 failures across 48 checks. The failures were concentrated in:

- missing accessible names for Policy Center time, policy, and Access role controls;
- an undersized active-access checkbox;
- a non-focusable horizontally scrollable Ads table;
- light-theme low-contrast secondary text; and
- incomplete dark-theme compatibility mappings for legacy direct palette utilities.

The remediation kept the changes inside Team and audit infrastructure:

- added meaningful accessible names to structured Policy Center controls and repeated Access selectors;
- raised active-access checkboxes to the WCAG target-size minimum;
- made Ads performance tables named keyboard-focusable regions;
- expanded Team semantic theme compatibility for neutral, info, success, warning, and danger surfaces/text/borders; and
- corrected the instant-quote error-state test to distinguish the product alert from Next.js's route announcer.

The original unfiltered gate passed all 48 checks: 23 authenticated normal routes plus the representative empty/error/modal/drawer scenario at 1440px light and 375px dark. The permanent audit configuration was then expanded to all five target widths in both themes. That extension found three additional 320px defects: the ChatGPT Ads conversion table needed the same named focusable-region treatment as the other Ads tables, and the translucent quick-navigation background made its labels content-dependent in dark mode. The table is now keyboard focusable and named, and the small-screen navigation uses the opaque semantic surface.

The final clean-room matrix passed 232 checks, intentionally skipped 8 duplicate representative-state scenarios, and reported zero failures and zero flaky checks across 1440, 1024, 768, 375, and 320 pixels in both light and dark themes. This is automated WCAG evidence, not a substitute for human usability review or the later screenshot-based aesthetic scoring.

## Verification ledger

| Check                                       | Result | Notes                                                                                    |
| ------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Team shell and surface source contracts     | Pass   | 2 suites, 24 tests                                                                       |
| Partner navigation contracts                | Pass   | 9 tests, including validated nested return state                                         |
| Partner workspace cross-browser checks      | Pass   | 16 tests across Chromium and WebKit                                                      |
| Quote/Partner affected source contracts     | Pass   | 11 suites, 113 tests                                                                     |
| Calendar/Contacts/Expenses source contracts | Pass   | 7 suites, 82 tests after the semantic surface batch                                      |
| Partner Site inventory                      | Pass   | 234 tests                                                                                |
| Team audit runtime-safety contracts         | Pass   | 24 targeted API tests, including alternate loopback-port enforcement                     |
| `pnpm --filter site typecheck`              | Pass   | Contentlayer generated all 23 documents                                                  |
| `pnpm --filter site lint`                   | Pass   | Zero errors and zero warnings                                                            |
| Team authenticated automated WCAG gate      | Pass   | 232 passed, 8 intentional skips, 0 failed/flaky across 5 widths and both themes          |
| Disposable migration and deterministic seed | Pass   | All migrations applied; Partner lifecycle fixture now honors issued-invoice immutability |
| Monorepo production build                   | Pass   | 6/6 build tasks completed after the semantic surface and compatibility-audit batch       |
| Phase 1 full API inventory                  | Pass   | 469 suites and 4,739 tests passed on Node 20 before Phase 2 began                        |
| Mobile workflow changes                     | None   | One helper-only redirect refactor emits the same `/team/partners` destination            |
| Production visual baseline                  | Open   | Requires Phase 0 signed-in/screenshot evidence; local audit does not certify deploy      |

## Ranked Phase 2 work queue

Nested return-state coverage for the canonical Quote and Partner builders is complete for the supported Team handoffs. The first prospect-visible semantic batch is also complete for Calendar controls, Contacts, Expenses, and Partner access/scheduling entry surfaces.

1. Capture protected Mobile baselines and compare shared statuses, totals, permissions, and handoff outcomes—not pixel identity.
2. Use the screenshot review phase for human usability and aesthetic scoring; the complete automated responsive/theme matrix is now green.
3. Continue semantic migration only where screenshot evidence identifies a visible consistency problem; avoid replacing domain-status colors mechanically.
4. Retain classic Team until the documented privacy-safe usage, parity, staff-sign-off, and notice gates are satisfied.

## Phase boundary

Field-job action parity belongs to Phase 3, and crew Spend/permission parity belongs to Phase 4. Pulling those changes into this foundation batch would mix presentation cleanup with higher-risk operational behavior. Phase 2 can prepare their shared terminology, tokens, and navigation without changing how crews work today.
