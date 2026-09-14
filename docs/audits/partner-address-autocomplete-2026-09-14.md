# Partner request address suggestions — September 14, 2026

Status: implementation and focused API/browser checks are complete. The required CI journey and production deployment are pending.

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

- Four actual-component browser journeys passed in Chromium/WebKit at 1440px and 375px, with generated application styling. They cover selection, responsive bounds, unit preservation, manual overrides, debounce, keyboard/touch controls, held/stale responses, malformed/network/empty recovery, support references and manual save.
- Existing first-location and saved-request recovery passed in both browser engines (two checks).
- All 28 focused API tests passed, including the existing location verifier. API and Site type checking and focused lint passed. The required portal CI workflow now includes the new address browser checks and both new API test files.
- Browser fixtures isolate the lookup responses. The real-provider check above is separate; these results do not claim an authenticated LandL production browser journey.

## Deployment

Pending. No company settings or customer work have been changed for this feature. The earlier LandL six-tool activation and normal staff/partner sign-in checks remain pending as recorded in the [portal remediation audit](partner-landl-portal-remediation-2026-09-13.md).
