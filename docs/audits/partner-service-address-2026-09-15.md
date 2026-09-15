# Partner request service address — September 15, 2026

Status: implementation and release verification in progress. Deployment evidence is recorded below when available.

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
- The production journey uses disposable local accounts, PostgreSQL, storage and actual API/Site production builds.

## Deployment and limits

No database, worker, provider, company-tool, payment, notification, or appointment-confirmation change is required for this update. A read-only comparison found the existing API, Site and worker settings aligned with the approved configuration.

The Site release must pass the required Partner Portal production journey workflow before deployment. Roll back the Site to its preceding deployment if request entry regresses; no schema rollback is needed.

An authenticated LandL write journey is not claimed. Do not create test work in LandL's account. The earlier six-tool activation and normal staff/partner sign-in checks remain pending as recorded in the [portal remediation audit](partner-landl-portal-remediation-2026-09-13.md).
