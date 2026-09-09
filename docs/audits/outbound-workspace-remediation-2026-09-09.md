# Outbound workspace — September 9, 2026

## Purpose and scope

Make `/team/sales/outbound` a clear place to follow up with businesses, import prospects safely, and reach existing partner administration. This is a staff workflow, not a marketing page for the partner portal.

Verification below was performed locally without live calls/messages/invitations, account creation, database migration, or financial changes. Deployment and controlled production smoke checks are separate from this verification. Existing permission and Do Not Contact protections remain; no MFA requirements were introduced.

## Experience

- Three clear destinations: **Follow-ups**, **Import contacts**, and **Partners**, subject to the signed-in person's permissions.
- A visible **Add partner** action opens `/team/partners?p_admin=accounts&p_setup=create` and expands the company/Administrator invitation form immediately. No company is created merely by following the link.
- The searchable follow-up list replaces the wide table and separate mobile cards. Current owner, result total, selected filter, and refresh are visible.
- Advanced filters, bulk work, and activity totals are available through labeled expandable sections rather than competing with the day's work.
- Opening an account gives one responsive panel: matching contact/task, next step, call/Inbox actions, outcome/recap/callback, then optional drafting help, history, and tasks.
- Import is upload-first with a CSV template, optional paste, review totals, row filters, complete skipped-row downloads, explicit confirmation, and a result receipt.

## Findings and resolutions

| Problem found                                                                                | Implemented resolution                                                                                               | Evidence                                                                         |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Partner setup was hidden behind Outbound and a collapsed form.                               | Visible permission-gated Add partner shortcut with validated setup query and expanded form.                          | Navigation test plus actual local browser click through to the setup form.       |
| Navigation and import descriptions were duplicated across normal/error/import views.         | One shared header; one import destination; no repeated promotional/technical panels.                                 | Workspace browser checks, Site build.                                            |
| Large statistical cards and seven always-visible filters delayed reaching prospects.         | Follow-up list first; additional filters/activity/bulk work expandable.                                              | Local 320–1440 px visual inspection and browser assertions.                      |
| Five-column table squeezed business/contact information beside a narrow detail panel.        | One wrapping account list and responsive detail layout.                                                              | No horizontal overflow at 320, 375, 768, 1024, 1440 px in Chromium and WebKit.   |
| Mobile lacked desktop history, detailed recap, follow-up drafting and some outcomes.         | Both layouts render the same detail/actions components.                                                              | Detail browser journeys exercise those controls at 320 and 1440 px.              |
| Read-only staff saw controls that failed on submission.                                      | Separate call, message, draft, manage, import, and partner permissions control visibility.                           | Read-only browser journey and existing endpoint permission tests.                |
| Calls/messages appeared without the necessary stored contact details.                        | Only saved, available channels are offered; missing phone hides Call.                                                | Contact resolver and rendered-action tests.                                      |
| Linked-contact actions used the primary contact's task.                                      | Resolve each action to a task belonging to the selected contact; validate binding again at the draft API.            | Exact submitted contact/task/version assertions and draft route rejection tests. |
| A deep link to a nonprimary task opened the wrong contact's context.                         | Explicit initial task selects its matching contact; unknown tasks never fall back.                                   | Deep-link tests for valid, changing and unknown task IDs.                        |
| Separate callback, quick-outcome, and detailed-outcome forms duplicated decisions.           | One required outcome selector with optional recap and a required callback field only when applicable.                | Keyboard/browser callback validation and API callback tests.                     |
| A refreshed task could pair older typed notes with a new revision.                           | Preserve notes per contact/task; changed revisions block saving until explicitly reviewed or cleared.                | Browser revision guard and contact/task switching tests.                         |
| Quick filters could retain callback-only disposition, old cursor, and old account selection. | Filter navigation resets conflicting disposition, selection, cursor, and direction.                                  | Navigation tests and source contracts.                                           |
| Shortcut counts suggested whole-list totals even though the API returns filtered totals.     | Shortcuts no longer show misleading counts; list total and activity scope are labeled.                               | Workspace rendering and query contract tests.                                    |
| Unavailable team defaults left an unusable error page with no assignee picker.               | Queue failure retains navigation and offers an explicit teammate picker when directory data is available.            | Missing-default/unavailable-queue browser case.                                  |
| Missing selection could be unclear or show another record.                                   | Explain the unavailable selection and offer clear/reset; never substitute another account.                           | Empty-result and unavailable-selection browser cases.                            |
| Bulk fields were unrelated to the chosen action; selection counts could desynchronize.       | Controlled selection, explicit action, action-specific fields, DNC exclusion, 500-task guard and consistent reset.   | Real browser form payload, reset, permission and DNC checks.                     |
| Failed import re-preview could leave an old preview executable.                              | Invalidate prior executable state before previewing.                                                                 | Failed-preview browser test.                                                     |
| Uncertain imports could lose the original key and invite duplicate execution.                | Lock original inputs/key, bound requests, warn on leaving, and offer an explicit same-key retry.                     | 503 → 403 → success retry case and import transaction/contract tests.            |
| Import errors, exclusions and large results were difficult to work through.                  | Linked errors/focus, size checks, row filters/pagination, and full skipped-row download.                             | Upload/paste/size/row-filter/confirmation browser cases.                         |
| Generating a draft created or matched partner companies implicitly.                          | Use only existing explicit account/contact/task foreign keys; drafting no longer creates or merges companies.        | Draft route tests including legitimate legacy task linkage.                      |
| Draft API did not reject DNC/deleted contacts and wrong-task context early enough.           | Validate input, contact availability, contact restrictions and task/account associations before draft/thread writes. | Focused draft route tests.                                                       |
| Generic outreach could reuse a financial thread or read financial message context.           | Apply the existing generic staff Inbox scope to thread lookup, creation and history.                                 | Draft route financial-scope tests.                                               |
| Simply opening an account generated paid AI work and updated fit data.                       | Queue GET reads stored briefs only; missing brief stays optional with a simple call opener.                          | Read-only enrichment tests; no generator calls or account writes.                |
| Temporary network failure in draft/Inbox actions could crash the page.                       | Catch transport errors, show safe recovery feedback, validate successful receipts and avoid automatic replay.        | 31 server-action runtime recovery tests.                                         |

## Verification performed

- `corepack pnpm test:outbound`: **15 suites, 160 tests passed**. Includes query pagination, callback integrity, mutation contracts/transactions, import safety, draft binding/scope, read-only enrichment and server-action recovery. These are local test boundaries, not production PostgreSQL certification.
- `corepack pnpm test:outbound:browser`: **22 tests passed** across three scripts. Chromium/WebKit exercise real rendered components with synthetic data and isolated action/network boundaries.
- Workspace layout checks: 320, 375, 768, 1024 and 1440 px; no horizontal overflow. Keyboard expansion, restricted controls, DNC exclusions, complete list errors, bulk payload/reset, and direct Add partner form opening are covered.
- Axe checks: zero automated violations in tested follow-up and initial import views in light/dark themes; detail/action checks also cover keyboard disclosures and WCAG 2/2.1/2.2 AA rules. This is not a claim of manual screen-reader certification or an audit of the entire CRM shell.
- Site/API production builds passed. Site emitted browser-data/tooling warnings and nonfatal local data-fetch warnings during unrelated static-page generation; no Outbound compilation/type error was reported.
- Site and API TypeScript checks and focused ESLint checks passed. `git diff --check` passed.
- Inspected rendered mobile and desktop workspace screenshots locally. Browser tests use generated current Tailwind styles instead of depending on a previous build's CSS artifacts.

Reproducible browser scripts:

- `scripts/test-outbound-workspace.mts`
- `scripts/test-outbound-detail-components.mts`
- `scripts/test-outbound-import-components.mts`

## Production smoke check still required after deployment

1. Sign in as Owner and open **Sales → Outbound**. Confirm the three destinations and Add partner are visible.
2. Use a Stonegate-owned test relationship. Confirm Add partner reveals the correct company form; send an invitation only to a controlled recipient when ready.
3. Confirm the real team directory, assignee configuration, list totals and selected-contact history load.
4. With a controlled contact, verify call connection and Inbox draft/reply delivery. Draft creation alone must not send anything.
5. Record a real/test-authorized outcome and callback, then confirm persisted task updates and Eastern-time display.
6. Preview a small controlled CSV, review its changes, explicitly import it, and verify the persisted receipt and CRM results. Never import a real prospect list merely to test the interface.
7. Repeat with restricted staff permissions and a controlled Do Not Contact record.

No claim is made here that provider delivery, production permissions/configuration, real-device screen readers, or production database concurrency were newly certified by these local checks. This change does not add a separate `/mobile` Outbound screen or replace the broader Partner Administration workspace.
