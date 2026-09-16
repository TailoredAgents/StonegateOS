# Partner draft photo upload repair — 2026-09-15

## Report and findings

The customer saw a photo preview, a progress bar fixed at 0%, and “Photos not saved yet.” Selecting a file created a local browser preview but did not start an upload. The separate Attach photos button appeared below the preview, and the progress bar appeared before any transfer began.

Read-only Render job `job-daktphrm8hqs73em2b3g` inspected LandL's draft-media and finalization-operation metadata at 2026-09-16 00:04:07 UTC. Both lists were empty. No photo contents, filenames, credentials, or signed URLs were inspected or printed. The observed state matched a selected local file rather than a saved photo.

Two additional recovery defects existed: a resume response that skipped an already-completed transfer could remain at 0%, and a lost finalization response could leave the unsaved warning even when a subsequent read proved the photo was ready.

Separately, Billing's document security policy remained active after client-side navigation to Request service. It blocked both direct photo transfers and signed previews. This was reproduced using HTTPS fixtures in Chromium and WebKit; it was not attributed as the cause of the customer's selected-only state.

## Changes

- The chooser says Choose photos and explains the separate attachment action. Attach photos and Clear selection appear before the previews.
- Selected photos say Ready to attach, with no progress bar. Transfer, saving/verification, attached, and retry states are distinct. Active work uses a spinner rather than an error indicator.
- A transferred photo remains pending until a validated read confirms the exact current batch's media IDs are ready. This also recovers safely from a lost finalization response or a failed confirmation read.
- Failed or incomplete batches retain their files, notes, categories, client IDs, and operation keys. Resuming avoids another transfer when the server already has the file. Late reads cannot clear a newer selection.
- Billing permits only the configured exact private-storage origin in its existing `connect-src` and `img-src` directives. All other security directives, payment behavior, storage permissions, and bucket CORS rules remain unchanged.

## Live configuration and storage check

The Site's new nonsecret `PARTNER_MEDIA_STORAGE_ORIGIN` setting was set through Render's single-key environment endpoint and read back successfully. Its value came from the actual API-generated upload URL's origin; no storage credentials or signed URLs were copied to the Site.

Read-only storage preflight job `job-daktsojl550s73asa8e0` generated a short-lived signed upload URL without performing a PUT or creating a customer/media record. At 00:11:12 UTC, the canonical `https://stonegatejunkremoval.com` origin received HTTP 204 and allowed the required PUT, content-type, and if-none-match headers. The www and onrender aliases received 403; their bucket permissions were not expanded. The diagnostic's aggregate exit status was nonzero because it also checked those two unapproved aliases; the actual customer origin passed. This follows the documented browser preflight requirements in [Cloudflare's R2 CORS guidance](https://developers.cloudflare.com/r2/buckets/cors/).

Render environment API updates require a separate deployment, as described in [Render's API documentation](https://api-docs.render.com/reference/update-env-vars-for-service). The setting is activated together with the website code. Its format and Site build-time requirement are documented in `.env.example` and `docs/system/ENV_CATALOG.md`.

## Validation and release

- Source commit: `ad949c9887959d9f6b050b41c3ca63be94467ba2` on main.
- Exact release candidate: `3d48d1330163dc4c370e461aa434617d4f8c27e4`, branch `release/partner-photo-upload-20260915`, based on the current live `c46ae5596aa8a4aa5554d3bb775d38e96b97ca27` so the latest commercial-page and advertising changes are retained.
- Focused photo checks: 16/16 passed. Real local XHR transfers were exercised in Chromium/WebKit at desktop and phone widths, including resumed transfers, interrupted requests, malformed/failed/wrong-ID confirmation reads, stable retry identity, file/metadata preservation, and navigation blocking while photos remain pending.
- Focused security/payment checks: 13/13 passed, including HTTPS browser navigation tests and rejection of wildcard, insecure, credential-bearing, and malformed origin settings.
- Scoped lint, formatting, and diff checks passed. The shared working tree's full typecheck was blocked by unrelated concurrent cookie-consent changes; the isolated release gate checks the actual deployable tree.
- Required exact release gate: https://github.com/TailoredAgents/StonegateOS/actions/runs/35039111990 passed for `3d48d1330163dc4c370e461aa434617d4f8c27e4`, including both production builds and all four desktop/phone activation, request, and CRM journeys.
- Matching main gate: https://github.com/TailoredAgents/StonegateOS/actions/runs/35039105860 passed for `ad949c9887959d9f6b050b41c3ca63be94467ba2`.
- Exact release totals: 999 API tests across 139 suites, 203 Site tests, 14 focused route tests, 35 browser/config checks, and 223 PostgreSQL tests across 41 suites. Worker rendering passed with zero network attempts. The full successful run log is retained at `/tmp/stonegate-photo-release-3d48d1-ci-full.log`; failure-only diagnostic artifact uploads correctly did not run.
- Website deployment `dep-dakuliv40ujc738u7q4g` became live at 2026-09-16 01:07:04 UTC with the exact release SHA. The trigger checked both the live website baseline and the configured media origin before deploying. No API or worker deployment was needed.
- At 01:09:18 UTC, all six provider-host checks passed: API and Site health; API readiness with portal available, database/migrations/worker healthy and zero dispatchable events; normal unauthenticated login redirect preserving the draft ID; unauthenticated catalog rejection; and the deployed Billing policy allowing the exact storage origin only for connections and images. Existing Square origins and restrictive default/object/frame directives remained intact, with one policy and no wildcard.
- A concurrent commercial-page deployment, `dep-dakuoju7bikc73dokre0` at `e4648a0205a4871bd9b7dc513e3dece5f760c6a1`, became live at 01:13:30 UTC. Its tree differs from this release only in three commercial components/styles and their audit document; it retains every photo fix.
- Independent canonical-domain checks also passed. GET-only Render job `job-dakupaf40ujc738uj9ig` checked at 01:11:56 UTC and completed successfully at 01:12:03 UTC: health and sign-in returned 200; Billing returned its normal 307 with the storage origin allowed for connections and images; www redirected to the canonical hostname. A fresh Chromium browser with normal TLS verification also reached canonical sign-in and health successfully at 01:11:31 UTC. Native curl/Node calls from the development machine encountered a TLS protocol error; the browser and remote-server results distinguish that local check limitation from a public-site outage.
- Canonical Chromium response checks at 01:13:16–17 UTC confirmed Billing returned 307 with one policy, the exact storage origin only in `connect-src`/`img-src`, no wildcard, and the original restrictive default/object/frame directives. The saved draft redirected to Partner sign-in with its draft ID preserved.
- All six provider-host checks passed again at 01:33:16 UTC. The same canonical Billing and saved-draft browser checks passed again at 01:33:23 UTC against the latest live commercial deployment, using normal TLS verification; `/tmp/stonegate-canonical-photo-browser-final.json` records the result. The portal implementation and configuration files are byte-for-byte identical between the tested photo release and that subsequent deployment.
- No Site/API application errors or portal-path HTTP 5xx responses appeared in the observed post-release log window, 01:07:04–01:32:58 UTC.

The production-build browser journeys used controlled local test data. No signed-in production customer browser was available; live checks used unauthenticated requests, read-only account metadata, and a storage preflight. No customer upload, request, or booking was created for these checks. The read-only inspection and preflight did not modify LandL's draft.
