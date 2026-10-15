# Team Console visual refresh plan

Status: Complete

Started: 2026-10-15

Scope: authenticated Team Console desktop and responsive web shell

## Outcome

Make the operating system feel unmistakably Stonegate, easier to scan, and
strong enough to demonstrate to another junk-removal company without changing
its workflows or production data.

The visual language uses the colors already present in the Stonegate identity:
deep navy for navigation and structure, green for primary actions and active
work, warm sand for the application canvas, white for working surfaces, and
gold only as a restrained brand accent. Semantic green, blue, amber, and red
remain reserved for operational status.

## Guardrails

1. Do not reset, delete, migrate, or rewrite production data.
2. Do not change permissions, routes, mutations, provider behavior, or business
   workflow semantics as part of this refresh.
3. Preserve light and dark themes, keyboard focus, reduced motion, minimum
   touch targets, and text equivalents for color-coded states.
4. Keep the dedicated `/mobile` field application unchanged. Shared changes
   must not alter Jeffrey's established mobile job workflow.
5. Keep responsive Team Console navigation usable at 320 px through wide
   desktop layouts.
6. Prefer shared semantic tokens and primitives over page-specific colors so
   future pages inherit the same visual system.

## Phase 1 — Brand foundation and shared primitives

- Establish explicit navy, green, gold, sand, selection, and elevated-surface
  tokens for both themes.
- Increase separation between the application canvas, navigation, cards,
  nested surfaces, and selected records.
- Reduce oversized shadows and excessive pill-shaped controls.
- Define consistent radius levels for controls, panels, and status pills.
- Preserve semantic success, information, warning, and danger treatments.

Acceptance:

- The shared Team UI exposes one coherent hierarchy for cards, controls,
  selection, and status.
- Dark mode retains readable contrast and does not inherit light-only colors.

## Phase 2 — Application shell

- Give the sidebar a distinct Stonegate navy treatment in light mode.
- Strengthen active navigation with a clear white/green selected state.
- Give the top header and page title more visual authority.
- Simplify surface shadows and add restrained brand accents.
- Apply the same sidebar treatment to the responsive navigation drawer while
  leaving the dedicated field app untouched.

Acceptance:

- Navigation, page chrome, and working content are visually distinct at a
  glance.
- Existing collapse, account, theme, access, keyboard, and phone-navigation
  behavior remains unchanged.

## Phase 3 — Calendar reference workspace

- Strengthen the calendar toolbar and selected view.
- Differentiate filters from the schedule rather than rendering every region
  as the same white card.
- Improve day-column hierarchy, today/selected-day visibility, event density,
  and the details panel.
- Keep operational status colors and complete calendar functionality intact.

Acceptance:

- The schedule is the visual focus, filters are secondary, and appointment
  states remain understandable without color alone.
- Day, week, and month views remain responsive and keyboard accessible.

## Phase 4 — Partner Outreach reference workspace

- Strengthen the page header and workspace navigation.
- Clarify quick filters and selected-prospect state.
- Make the prospect detail column sticky on wide screens so long lists do not
  leave an empty right rail.
- Improve scan density and distinguish overdue, due-now, scheduled, and
  not-started records.
- Preserve imports, calls, SMS, email, dispositions, pagination, DNC, and safe
  retry behavior.

Acceptance:

- An operator can identify the selected account, its urgency, and the next
  action immediately.
- The long queue feels like a working console rather than a raw database list.

## Phase 5 — Verification and handoff

- Update source contracts for the new semantic visual tokens.
- Run formatting, Team shell, Calendar, Outbound, accessibility, and Site
  type-check gates.
- Review the final diff for accidental route, permission, data, API, or mobile
  changes.
- Record the completed phases and any deferred page-by-page aesthetic work.

Acceptance:

- All focused checks pass.
- Only `stonegate-site` requires deployment.
- The work is committed and pushed to `main` with a clean tree.

## Deferred follow-up

After this system foundation ships, capture each Team Console page at desktop
and responsive widths, score it from 1–100, and apply page-specific polish in
priority order. That review should reuse these tokens instead of creating new
local palettes. The partner portal and dedicated `/mobile` application require
their own separately approved visual reviews.

## Completion record

Completed: 2026-10-15

- Added the shared Stonegate navy, green, gold, sand, elevated-surface, and
  selection tokens in light and dark themes.
- Refreshed the desktop Team shell and responsive Team navigation drawer while
  leaving the dedicated `/mobile` application unchanged.
- Updated Calendar hierarchy, day and month states, empty states, and the
  large-screen details rail.
- Updated Partner Outreach navigation, filters, urgency badges, selected rows,
  and the large-screen prospect detail rail.
- Preserved all data, routes, permissions, provider behavior, and workflow
  semantics.
- Passed Site type-checking and lint, 35 focused Calendar, Outbound, shell, and
  accessibility assertions, and 17 Partners/Outreach navigation tests across
  Chromium and WebKit. Ten CSV-import browser checks also passed across both
  engines.

The aggregate Outbound browser command still has two pre-existing Node 22 ESM
loader failures before those test files can run. Both named exports are present
in source, the project declares Node 20, and this refresh did not modify either
module. This is recorded as test-infrastructure follow-up rather than a visual
or production regression.
