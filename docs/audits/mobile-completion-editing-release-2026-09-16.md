# Mobile completion editing release — September 16, 2026

Status: deployed and verified at 17:34 UTC.

## Problem and behavior

An unset final total and incomplete crew selection opened automatically while their explicit editing state remained false. The first valid digit or selected crew member made the compact summary eligible to render, unmounting the active input and dismissing the keyboard or crew controls.

The total now enters editing state on its first input change. The compact crew editor enters editing state on changes to any of its inputs, including hourly rate, hours and minutes. The total stays open through entry, and crew selection closes through the existing **Done changing crew** control. Saved summaries, draft recovery, legacy layouts, payment permissions and concurrent-total conflict handling retain their existing behavior.

## Release source

- Main source commit: `4d5dead6`.
- Production revision: `b119e5a95ddda0ac8566452c862f9a8abf7591ff`.
- Release branch: `release/mobile-completion-editing-20260916`.
- Based on the previously live Site revision `c260e2a920b19c8a2f9994e7ac2321024dd629e6`, preserving the current production releases.
- Only two UI components and the compact completion regression script changed. No API, worker, database, configuration or environment changes.

## Validation

- All ten new first-entry browser scenarios failed against the original components and passed with the fix, across Chromium and WebKit with mobile touch contexts.
- The browser checks cover multi-digit totals, multiple crew members, new hourly crew details, incomplete saved hourly details and incomplete restored drafts. They verify that the original input remains mounted and focused after each character, and that exact totals and crew values submit correctly.
- Mobile booking-card suite: 42 tests passed, including recovery, booking addresses, completion actions and compact editing. Completion action coverage includes 44 additional runtime assertions.
- Crew payout and moving-job component suites: 10 tests passed.
- Site type checking and production build passed in the isolated release worktree. Scoped component lint, standalone TypeScript lint for the changed regression script, formatting and diff checks passed.
- Independent review found no blocking issues. The required Partner Portal production journey gate does not apply to this mobile completion-only UI change.

## Deployment and verification

- Site service: `srv-d43o7c0dl3ps73a4rb2g`.
- Deployment: `dep-dald3vvf3r2c738rfa30`, started at 17:29:35 UTC and live at 17:33:16 UTC at the exact release revision above.
- Render Site and API health endpoints returned HTTP 200 after deployment. Anonymous Site `/mobile` and `/team` requests retained their normal HTTP 307 login redirects.
- A fresh headed Chromium session with normal certificate verification confirmed the canonical domain at 17:34:22 UTC: `/api/healthz` returned 200 with `ok`; `/mobile` and `/team` redirected to their login pages, which returned 200.
- No Site error-level logs appeared between deployment completion and the final log check at 17:34:11 UTC.
- Rollback: restore the previous Site deployment `dep-dalcvaf40ujc73dj43og` at revision `c260e2a9`.

Browser editing behavior was exercised locally; production verification uses read-only health, authentication and deployment checks without editing real jobs.

Canonical-domain checks encountered intermittent transport-specific filtering in this local environment, including before the new revision became live. The successful final browser check used normal TLS and no proxy or certificate overrides. Evidence is retained locally in `/tmp/stonegate-mobile-completion-canonical-postdeploy-retry-20260916.json`.
