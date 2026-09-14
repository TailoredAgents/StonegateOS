# Partner request address suggestions — September 14, 2026

Status: the address-autocomplete feature is deployed on the API and Site. Focused checks, the required CI journey, production readiness and the live anonymous-access boundary checks passed. An authenticated LandL production journey was not performed.

## Behavior

- The Request service inline location form searches after three characters and a short pause. Selecting a suggestion fills street, city, state and ZIP.
- Suite/unit details and manually overridden fields are preserved. Changing a selected street clears the previous autofilled city/state/ZIP when those values have not been manually changed.
- Mouse, touch, arrow keys, Enter and Escape are supported. Enter in the search field cannot submit the location form, including while a lookup is pending.
- Empty, failed and malformed lookups leave manual entry available. Old responses cannot replace newer results. Failures retain a support reference.
- The existing save/verification flow and staff appointment confirmation remain in place.

## Server and provider

- Authenticated `POST /api/portal/v2/address-suggestions` requires the same account-wide location-management permission as location creation, and effective portal reads/writes. The Site proxy forwards the request through its existing origin checks.
- Typed addresses travel in the JSON body, keeping them out of normal request-log URLs. The Mapbox token stays on the API. Inputs, provider responses, lookup duration and request rate are bounded. Diagnostics contain only safe reason/status codes and a support reference.
- The existing Mapbox Geocoding v6 integration returns at most five US addresses, with an Atlanta proximity preference. Permanent geocoding is requested because selected address data can be saved; the existing portal address verifier now uses that parameter too. [Mapbox storage documentation](https://docs.mapbox.com/api/search/geocoding/#storing-geocoding-results).
- Production token presence was checked without printing it. A public-landmark provider request returned HTTP 200 and three successfully parsed suggestions. Mapbox's long opaque IDs are represented by bounded stable hashes in the portal response.

## Validation

- Four actual-component browser journeys passed in Chromium/WebKit at 1440px and 375px, with generated application styling. They cover selection, responsive bounds, unit preservation, manual overrides, debounce, keyboard/touch controls, held/stale responses, network/empty recovery, support references and manual save. The separate API tests cover malformed provider responses.
- Existing first-location and saved-request recovery passed in both browser engines (two checks).
- All 28 focused API tests passed, including the existing location verifier. API and Site type checking and focused lint passed. The required portal CI workflow now includes the new address browser checks and both new API test files.
- Browser fixtures isolate the lookup responses. The real-provider check above is separate; these results do not claim an authenticated LandL production browser journey.

The [required portal workflow](https://github.com/TailoredAgents/StonegateOS/actions/runs/34841958164) passed at `073d10888d289a7ba6e5d66351cd988345699a33`: 989 API tests, 193 Site tests, 223 PostgreSQL tests, 12 recovery checks, four autocomplete browser checks, worker rendering with zero network attempts, both production builds and both real desktop/phone new-company journeys.

The [general E2E workflow](https://github.com/TailoredAgents/StonegateOS/actions/runs/34841958249) retains exactly the preexisting 127 failing suites and 208 failure labels from `8ebec619`; no new failures were introduced. Its passing tests increased by 23, and its typecheck, lint, quote and expense checks passed. The older failures still block automatic deployments; this release is manually pinned to the revision that passed the required portal workflow.

## Deployment

- Application revision: `073d10888d289a7ba6e5d66351cd988345699a33`.
- API deployment `dep-dajudcjm8hqs739oqlgg` was live at 12:25:45 UTC; Site deployment `dep-dajufn7qj5pc73f4qkq0` followed and was live at 12:30:03 UTC.
- API pre-deploy verified migration `0174_dynamic_crew_labor` at 12:24:29 UTC, with no pending migrations and no database changes. Configuration/database/migration readiness passed at 12:24:34 UTC and again after both services were live.
- Existing production settings were checked before deployment and required no changes. The worker remains on `f089cbe5`; this change does not add or change a worker path.
- The deployed API rejected an unsigned address lookup with the expected HTTP 401 and a support reference. A fresh Chromium session on the actual Site loaded the normal login page and received the same correct response through the Site proxy. These are access-boundary checks, not a signed-in account lookup.
- API application/request logs were clean from 12:25:45 to 12:26:26 UTC. API/Site warning/error logs and portal HTTP 5xx checks were also empty from 12:26:26 to 12:30:40 UTC, with no additional log pages. Expected HTTP 401 smoke requests are accounted for.
- No authenticated production location save was performed for this feature. The controlled browser tests verify address selection and saving manually entered addresses; the separate real Mapbox check verifies the provider connection. No company settings or customer work have been changed for this feature. The earlier LandL six-tool activation and normal staff/partner sign-in checks remain pending as recorded in the [portal remediation audit](partner-landl-portal-remediation-2026-09-13.md).
