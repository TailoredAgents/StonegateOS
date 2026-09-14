# LandL Partner Portal remediation — September 13, 2026

Status: implementation and verification in progress. The user approved deployment. The results below distinguish local verification from production checks; a pending item is not a completed release gate. The deployment owner will update the final deployment record.

## Agreed behavior

- LandL can use the portal and all six company tools: saved service templates, recurring service, bulk requests, reports, portfolio tools and approval rules.
- Stonegate staff confirms every service request. Instant confirmation stays disabled.
- Billing shows existing financial records. Card, ACH and hosted payment collection stay disabled. This release does not enable outbound notifications.
- Keep the existing company identity and stored name, including its spelling. Do not create sample locations, jobs or financial records in LandL.

These are the current release settings. Historical references to enabling embedded payments in the [service release runbook](../runbooks/partner-relationship-service-release.md) do not change this release's view-only billing scope.

## Findings and implemented fixes

| Finding                                                                                                                                          | Fix                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production API and worker did not have explicit portal read/write switches. Those switches default off in production, even though sign-in works. | Set explicit core settings for both services in [render.yaml](../../render.yaml). Add portal configuration readiness and expose effective availability through `/api/portal/v2/me`.                                                                                                         |
| LandL had an active Administrator with company-wide access, but no enabled optional tools.                                                       | Preserve role and account boundaries. Enable the six tools through the normal staff company-settings workflow; the live settings change is still pending normal staff sign-in.                                                                                                              |
| LandL had no locations, jobs, drafts or invoices. Errors and disabled-feature messages obscured a valid new-company starting point.              | Separate genuine empty results from permission, maintenance, sign-in, malformed-response and temporary server errors. Provide retry and support references without presenting failures as empty records.                                                                                    |
| Home combined unrelated load failures; other pages could discard successful data during refresh.                                                 | Validate each response, show independent Home section errors, retain successful data during retry, and preserve saved-tool, update and proof history on failed refreshes.                                                                                                                   |
| Location creation was tied to advanced portfolio tools.                                                                                          | Allow the first basic location when the member has the required permission and writes are available, independently of advanced portfolio settings.                                                                                                                                          |
| Page actions did not consistently follow actual operational availability.                                                                        | Apply shared read/write availability to portal pages and actions. Show coherent maintenance/read-only wording; keep help and permitted personal settings usable. Show accurate photo/document and payment availability.                                                                     |
| Repeat-service evaluation needed a running worker path.                                                                                          | Connect the recurring horizon evaluator to the worker and retain staff-review behavior, existing series state and retry safeguards.                                                                                                                                                         |
| The actual quotes list returned HTTP 500 during the local production journey.                                                                    | Correct the quotes route's database query and add a route regression check. The complete journey and API aggregate passed after that fix.                                                                                                                                             |
| Healthy process checks and mocked browser fixtures did not prove a new company could use deployed portal services.                               | Add a [production-build journey workflow](../../.github/workflows/partner-portal-release.yml), a real API/database [empty-company browser journey](../../scripts/test-partner-empty-company.mts), and a read-only [deployed release check](../../scripts/check-partner-portal-release.mts). |

The initial live investigation found matching deployed code at `dad3e902`, migrations current through `0174`, and healthy database and worker services. Missing core switches, separate account-tool settings, and misleading page handling were distinct problems. Quote signing/proxy configuration also failed readiness and requires verification during deployment.

The local production journey also exposed a Team access parser mismatch: the valid members response includes the existing `scope_update` action. The parser and Site type now accept that action while still rejecting unknown actions. Both actual members and invitations responses from a newly activated local Administrator pass validation, and the rebuilt browser journey passes.

## Evidence recorded so far

| Check                                   | Result and limit                                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portal API unit aggregate               | 893 passed; 73 skipped. The separate PostgreSQL lane exercises the database cases.                                                                                                                                                                   |
| Portal PostgreSQL integration aggregate | 223 passed against disposable PostgreSQL, including the final confirmation and proof-sharing cases.                                                                                                                                                                                                                       |
| Quotes route regression                 | 7 passed after the query fix. This is a separate targeted result, not a replacement for the aggregates or browser rerun.                                                                                                                                        |
| Portal Site aggregate                   | 192 passed.                                                                                                                                                                                                                                                     |
| Browser recovery checks                 | 12 passed across Chromium and WebKit: Home retention/retry, booking/location recovery, template/proof recovery, and communications.                                                                                                                                                        |
| Site static validation                  | Scoped type checking, lint and whitespace checks passed for the reliability changes.                                                                                                                                                                            |
| Worker runtime                          | Import/render check passed without network calls. This does not certify live delivery or storage.                                                                                                                                                               |
| Proof package memory                    | Local 40-photo case produced a 419,450,501-byte ZIP; peak RSS was 264,496 KiB. This does not establish production concurrency capacity.                                                                                                                         |
| Local production journey                | Desktop 1440px and phone 375px passed: real setup, activation and password sign-in; every normal tab and company-settings view; first location/private code; reviewed request with no appointment promise; photo upload/finalize/view; in-app message; payment API rejection; all six company tools and reports. |
| Live recurring inventory                | Zero series and zero occurrences at the time of inspection.                                                                                                                                                                                                     |
| Live LandL inventory                    | Existing company and membership preserved; no locations, jobs, drafts or invoices at the time of inspection. Six-tool activation remains pending normal staff sign-in.                                                                                          |
| Production R2 CORS repair               | The existing rule lacked `if-none-match`. Added that request header while preserving the rule. Preflight from the correct Site origin changed from 403 to 204. No objects were uploaded.                                                                        |

Latest Site aggregate: **192 passed, zero failed or skipped**. Phone Settings overflow was measured and corrected without hiding content. The final production journey verifies no horizontal page overflow at 375px.

Local browser setup uses isolated test infrastructure. It does not prove production staff password sign-in, partner sign-in on the real domain, provider delivery, or a production upload/download journey.

## Remaining release checks

- Deploy the reviewed revision to Site, API and worker. Verify effective settings on each service, including explicit reads/writes, purpose authentication, disabled routine magic login/test mode, and no canary restriction.
- Repair and verify quote secrets and the actual trusted-proxy hop configuration without logging secrets. Verify location/proof keys and portal/migration readiness.
- Sign in through the normal staff flow and enable LandL's six tools through company settings. Confirm the company scheduling policy still requires staff review and all payment collection remains off.
- Sign in as LandL normally on the production domain. Run `pnpm check:partner-portal:release` with the expected account ID and a normal session supplied only through the environment; inspect every portal tab for accurate empty states and available actions.
- Verify any authorized production request or media journey separately; R2 preflight success alone does not prove object upload, processing or download. Do not insert test records into LandL to satisfy a test.
- Confirm the deployed worker's recurring evaluator is healthy and record post-deployment errors/support references and monitoring observations.

Automatic deploys for the API, Site and worker now use `checksPass` (verified through Render readback). The API [pre-deploy check](../../apps/api/scripts/check-partner-portal-deployment.mts) rejects missing configuration or incompatible database state while permitting explicitly configured maintenance. Activate this check after the code and configuration cutover.

## Deployment record — pending owner update

- Reviewed/deployed revision: pending.
- Site, API and worker deployment identifiers and completion times: pending.
- Final readiness and normal-auth checks: pending.
- LandL company-tool settings verified through normal staff access: pending.
- Final local aggregates and production-build journey: pending.
- Rollback reference and post-deployment observation window: pending.

Use the required portal gate in the [release checklist](../RELEASE_CHECKLIST.md). For recovery, prefer a narrow write/instant-confirmation switch or the previous known-good deployment while preserving accepted records and company identity.
