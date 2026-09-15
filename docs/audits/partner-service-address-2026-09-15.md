# Partner request service address — September 15, 2026

Status: application changes are committed, pushed and live on the Site at `e5616004f987943ecdbbff2b84310c1cb1bfd535`. Local validation and the required release workflow passed.

## Request flow

- A new Request service opens directly to the street address form. Saved addresses are available through **Use a saved address**; the company default is not silently selected.
- The steps are **Service address**, **Service details**, **Scheduling**, and **Review and submit**. Mobile navigation uses the shorter labels Address, Details, Scheduling, and Review.
- Street address appears first. Suite/unit and location label are optional; an omitted label uses the street address. One **Continue** action saves the address, persists its selection on the current request, and opens Service details.
- A restored draft or explicit location link retains its chosen address. Switching between new entry and saved addresses preserves typed fields while the address step remains open.
- Typing an unsaved address displays **Address not saved** and activates the existing navigation warning. Switching address-entry modes focuses the newly displayed field.
- Saved requests appear below the main form. Restricted users continue to choose addresses they can access and receive appropriate instructions for adding a new one.
- Address lookup failures offer an explicit retry without clearing the entered address. Manual entry remains available. An expired sign-in keeps its sign-in instruction.

## Intermittent address lookup

The reported address and twelve partial-address queries succeeded through the existing provider configuration. The user's subsequent live retest produced seven API and seven matching Site proxy requests, all HTTP 200, between 11:39:47 and 11:39:59 UTC. No provider or production configuration was changed before that retest.

The earlier failure could not be reproduced and its cause is unconfirmed. The retry control improves recovery; it is not evidence of a diagnosed or repaired provider defect. Typed addresses, provider responses and credentials are omitted from this audit.

## Validation

- Local portal regressions: 916 API tests passed with 73 database-dependent tests skipped; all 193 Site tests passed. The database-dependent suites run separately in the required release workflow.
- Site type checking and focused page/component lint passed; final browser and production-journey results are recorded with the release below.
- Six final browser checks passed: Chromium/WebKit at 1440px and 375px plus both saved-request recovery checks. They exercise address entry, optional label fallback, a single Continue, duplicate-submit protection, saved-address selection, draft restoration, dirty-address warnings, keyboard focus, same-query retry and expired sign-in. The retry control includes the same pointer-focus safeguard as suggestion selection so it works in WebKit.
- Both local production builds passed. Both real production-build journeys passed at 1440px and 375px using disposable local accounts, PostgreSQL and storage. They verified activation, every tab, first inline address, optional label fallback, suite preservation, draft restoration, explicit saved-address selection, account-default behavior, both explicit location URL parameters, staff-review submission, photo/message handling, company tools and a fresh password sign-in. Browser contexts were closed after the journeys; disposable local database records were retained.
- The desktop and phone production screenshots were visually reviewed. No horizontal overflow or unusable controls were found.
- The [required Partner Portal production journey](https://github.com/TailoredAgents/StonegateOS/actions/runs/34965353008) passed at `e5616004f987943ecdbbff2b84310c1cb1bfd535`: 989 API tests, 193 Site tests, 223 PostgreSQL tests, 12 browser recovery checks, four autocomplete/wizard browser checks, worker rendering with zero network attempts, both production builds and both actual desktop/phone new-company journeys. No tests were skipped in this workflow.
- The [general E2E workflow](https://github.com/TailoredAgents/StonegateOS/actions/runs/34965353046) retains exactly the same 127 failing suites and 208 failure labels as `f1330c15` ([baseline](https://github.com/TailoredAgents/StonegateOS/actions/runs/34920921086)); no suites or failure labels were added or removed. Counts are unchanged: 3,358 passed, 208 failed and 269 skipped. Application typecheck, lint, quote PostgreSQL and expense PostgreSQL passed. These existing failures continue to block automatic deployment, so the Site release is manually pinned to the revision that passes the dedicated portal workflow.

## Deployment and limits

No database, worker, provider, company-tool, payment, notification, or appointment-confirmation change is required for this update. A read-only comparison found the existing API, Site and worker settings aligned with the approved configuration.

- Site deployment `dep-dakj63qd0e5s73e5h3ag` became live at 12:03:13.599 UTC. The API remains at `073d1088`; the worker remains at `f089cbe5`. This update changes Site behavior only.
- Production API configuration, migration and server readiness passed after deployment. The normal public-domain login page loaded successfully in a fresh Chromium session; an anonymous address lookup through the Site proxy returned the expected HTTP 401 and a support reference. A separate fresh Chromium session received HTTP 200 from the public Site health endpoint. An independent external fetch also reached the public login page.
- Native Node/curl checks from this computer encountered TLS negotiation errors on the public domain, while the Render hostname answered HTTP 200 and the normal Chromium public-domain checks passed. The native-client discrepancy remains unexplained and is recorded as a verification limitation; those failed checks were not counted as passes. No TLS or DNS settings were changed.
- The complete API/Site log window from 11:59:00 through 12:06:49 UTC contained 34 application lines, zero application warnings/errors and zero HTTP 5xx responses, with no further log pages. The single anonymous Site address lookup at 12:05:10.894 UTC returned the expected 401. Both public domains are verified in Render.
- Local API/Site/HTTPS processes and the two rehearsal containers were stopped after verification. Screenshots, logs and container data were retained.

The Site release passed the required Partner Portal production journey workflow before deployment. Roll back the Site to preceding deployment `dep-dajufn7qj5pc73f4qkq0` (`073d10888d289a7ba6e5d66351cd988345699a33`) if request entry regresses; no schema rollback is needed.

An authenticated LandL write journey is not claimed. Do not create test work in LandL's account. The earlier six-tool activation and normal staff/partner sign-in checks remain pending as recorded in the [portal remediation audit](partner-landl-portal-remediation-2026-09-13.md).
