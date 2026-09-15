# Partner service category repair — 2026-09-15

## Problem and scope

LandL's Service type field offered only the general Request service option. The three canonical catalog entries (`junk-removal`, `demo-hauloff`, `land-clearing`) already existed and were active, but LandL's company workflow settings were `{}` at revision 1. The company had no service agreement. The effective catalog therefore contained only the general request option.

This repair enables those three existing categories for LandL as requests requiring Stonegate review. It does not create prices, agreements, scheduling profiles, customer jobs, or appointment confirmations.

## Live configuration repair

- Company: existing LandL Sordough account, `74ce0567-c59e-4f57-a121-569918ae27f6` (stored name preserved).
- Read-only inspection: Render job `job-dakseg2jnfac73fplv60`.
- Authorized maintenance: Render job `job-dakshd3m8hqs73eha50g`, succeeded at 22:38:21 UTC.
- Workflow revision: 1 → 2.
- The only workflow JSON change was adding `requestableServiceKeys: ["junk-removal", "demo-hauloff", "land-clearing"]`.
- Audit record: `6f7e3be7-1bf1-4691-9420-33dfd711ee54`, action `partner.account.service_requestability.repaired`, correlation `landl-service-categories-20260915`.
- The repair ran inside a transaction with the normal recurring/scheduling advisory locks, exact account and revision checks, an unchanged-settings check, and active-catalog checks. Any concurrent settings change or explicitly disabled category would abort it.
- The audit used a system maintenance actor. No human sign-in or staff session was fabricated.
- Global instant confirmation was required to be explicitly disabled, and LandL's existing scheduling policy was checked to remain disabled. Other company settings and all commercial records were preserved.

## Request form corrections

Multiple categories exposed four existing selection problems. New requests now start with an explicit choice when several services are available. Saved drafts retain their exact saved service and base option, including an intentionally blank choice. A removed or disabled service requires a new selection before scheduling. Changing categories clears the previous pricing/availability and requires scheduling to be checked again, even when the old request had no held appointment.

Descriptions and attached or pending photos remain intact. A corrected service selection clears its resolved validation warning while preserving unrelated save failures.

## Validation and release

- Source commit: `0126545e3accccd824d80973dbeddee150bc9770` on main.
- Release candidate: `b96a50ccc15ee8c8c139ffd19451744050bfae5f`, branch `release/partner-service-categories-20260915`.
- The release retains the latest live website commit `692c0a4c05aa1b770d3132605c726ec6d2851861`, including the concurrent advertising changes.
- Independent Chromium/WebKit Service details tests: 6/6 passed, including the multiple-service scenarios, restored drafts, service changes, and photo preservation.
- Existing focused API requestability/catalog tests: 2 suites, 6 tests passed.
- Scoped lint, Site typecheck, and diff checks passed.
- Exact release totals: API 139 suites / 999 tests; Site 201 tests; focused route tests 14; browser recovery/presentation tests 26; PostgreSQL 41 suites / 223 tests. Worker rendering checks, both production builds, and all four real desktop/phone journeys passed. Full log retained locally at `/tmp/stonegate-service-categories-release-b96a50-ci-full.log`.
- Required release gate: https://github.com/TailoredAgents/StonegateOS/actions/runs/35031724363 passed for the exact release commit. Matching main gate https://github.com/TailoredAgents/StonegateOS/actions/runs/35031715974 also passed. Both gates include production API/Site builds, fresh-company activation and first request, and CRM handoff on desktop and phone.
- Effective live application catalog verification: Render job `job-dakshsbl550s73angj5g`, passed at 22:39:24 UTC. The real `listPartnerServiceCatalog` function returned all four choices as available, `quote_required`, with no preset base price or base options; automatic confirmation remained off. The account JSON exactly matched the intended single-property change.
- Website deployment `dep-daksmam7bikc738i81og` became live at 22:51:57 UTC on the exact tested commit. The deploy trigger checked that the current live website was still the expected baseline. No API or worker deployment was needed for the form changes or company settings.
- Final checks at 22:52:29 UTC: API health, API readiness, and public-site health returned 200. Portal readiness was `available`, database/migrations/worker were healthy, and the dispatchable queue was empty. The unauthenticated booking URL correctly redirected to normal sign-in while preserving the existing draft ID; the unauthenticated catalog API correctly returned 401.
- Post-deploy website application error logs were empty in the check window. No portal-path HTTP 5xx responses were observed from the configuration repair through the final checks.
- No signed-in customer browser session was available to this run. Live account verification used the real application catalog on Render; browser action checks used controlled test accounts and the production builds. No customer request was submitted for verification.

The live account repair does not submit a test request or alter the customer's saved draft. Existing open pages need a refresh to retrieve the new catalog.
