# Partner confirmation resource capacity rollout

The owner reported the crew/equipment capacity error again after the fix was pushed to main. Production inspection found the website on `93476e51d7f5c61c5fe4ead51be68bbaa405fe7e`, while the API and outbox worker still ran `550f624cabf46005041a576b0fb91a7f8c397b98`. Pushing the changes had not deployed the scheduling fix to the API.

## Confirmed cause

A read-only production probe found the existing junk-removal test request still requested, without an appointment start time. Its crew and truck requirements each use one capacity unit. The compatibility crew and fleet each represent two units.

On September 23, three existing appointments each consume one unit and have no named-resource snapshot. The old API charged each appointment the entire two-unit compatibility resource. This incorrectly counted six crew units against the six-unit daily allowance. The corrected loader charges their actual weights: three units total. Explicit physical resources and genuine capacity/daily limits remain enforced.

The probe used a PostgreSQL `READ ONLY` transaction through a short-lived private Render job. It did not change appointments, resource settings, or customer data, and it did not queue notifications. An initial diagnostic attempt used an incorrect physical column name and failed without writes; the corrected probe succeeded.

## Release evidence

Application source: `93476e51d7f5c61c5fe4ead51be68bbaa405fe7e`.

[Partner Portal production journey 35718372238](https://github.com/TailoredAgents/StonegateOS/actions/runs/35718372238) passed for that exact commit, including API/site regressions, browser/worker checks, staff capacity checks, PostgreSQL integration tests, both production builds, and complete activation and request journeys.

The separate [general E2E workflow 35718372322](https://github.com/TailoredAgents/StonegateOS/actions/runs/35718372322) failed. Its failures include CommonJS test mocks executed with ESM Jest globals (`jest`/`__dirname` unavailable). This rollout does not claim that workflow passed or resolve its broader test-runner problems.

The API release includes the already-approved additive quote-required pricing migration `0181_partner_quote_required_services`. The website was already running this application source. API and worker deployments were requested for the exact same commit; unrelated local website design edits were not included.

## Rollout verification

- API deployment `dep-daphgv142hec73au91u0` became live at **2026-09-23 00:13:38 UTC**, on the exact tested source.
- Outbox worker deployment `dep-daphj9lg1s2s73adhabg` became live at **00:15:04 UTC**, on the same source. Site was already live on that source through deployment `dep-dapa3rnf3r2c73ei5lv0`.
- API and Site health and readiness checks passed over normal TLS after rollout. API readiness confirms migration `0181_partner_quote_required_services`, database and portal availability, healthy worker heartbeat, and zero dispatchable outbox events.
- During cutover, the old API briefly reported its obsolete migration expectation after the additive migration ran. The new API resolved this readiness response.
- API/Site logs from 00:13:40 through 00:15:39 UTC contained no application error records and no HTTP 500–599 responses; neither query had additional pages.
- A private read-only replay created before API cutover retained the old source and reproduced the failure: all ten hourly candidates from 8 AM through 5 PM Eastern on September 23 returned `crew_daily_limit`, with six incorrectly consumed units.
- Post-cutover job `job-daphk3ff3r2c73embmj0` verified the new source at **00:16:36 UTC**. The same production request, resource definitions, and ten candidate times now report available named resources. Daily usage is correctly three units against a six-unit limit.
- This replay exercised the actual deployed resource-plan loader, resource-block loader, booking rules, and assignment evaluator inside a read-only database transaction. It verifies resolution of the reported crew/daily-limit rejection; it does not create a booking or bypass other scheduling rules. The test appointment remained `requested` with a null start time.
