# ChatGPT ads measurement release — September 15, 2026

## Release scope

- Production base: `95462512792dfe4643ce6fe2705300052c66f6d9`.
- Tracking release: `04d3ed7f70e8d105861b346a2b7ff68e7108ba18`, branch `release/chatgpt-ads-20260915`.
- Review PR: https://github.com/TailoredAgents/StonegateOS/pull/2.
- Separate partner design changes on development main are excluded.
- No schema migration. Existing lead JSON fields and outbox store attribution, conversions, and measurement revocations.

## Verification completed before activation

- API and Site typechecks passed on the production-based release.
- 105 focused server tests and 10 browser-helper tests passed.
- Changed-code ESLint passed.
- Preview Playwright smoke: public Pixel, preserved click references, page view, durable preference revocation, opt-out persistence, and no Pixel on staff login.
- Actual OpenAI adapter accepted a validation-only event; no conversion was saved.
- Production Twilio access, number routing, and published Flow revision verified.
- Full Studio candidate passed Flow Validate; forwarding properties match published revision 72 exactly. Two HTTP widgets cover both termination paths plus one retry.
- Full release workflow: https://github.com/TailoredAgents/StonegateOS/actions/runs/35024347365 — passed.

The general development-branch E2E workflow failed in the broad API test suite, including existing `ReferenceError: jest is not defined` errors. Representative payment-schema and quote-scheduling failures were reproduced on unchanged live base `954625`; those tests and Jest configuration are identical. This report does not claim the general repository E2E suite passes.

## Activation and live verification

No API or Site error-level application logs were returned for the initial 21:36–21:38 UTC verification window.

All three services are live at the tracking release above. Verified at 21:37 UTC.

| Service | Deployment | Live at UTC |
| --- | --- | --- |
| API | `dep-dakrf70ae00c73dle8d0` | 21:29:54 |
| Outbox worker | `dep-dakrf7942hec73ava3a0` | 21:26:21 |
| Site | `dep-dakrij67bikc73fnthig` | 21:36:06 |

- Site and API health/readiness returned HTTP 200; database, migration state 0174, worker heartbeat, and outbox queue were healthy. No dispatchable events remained at the initial readiness check.
- Site Pixel ID matches; API and worker are enabled with matching conversion credentials and no external-send/dispatch/test-runtime block in the checked settings. No secret value appears in this report or Git.
- On the public production booking page, exactly one SDK script loaded successfully. OpenAI returned HTTP 202 for a batch containing SDK initialization, diagnostic, and one `page_viewed` event.
- Fresh staff-login navigation loaded no OpenAI Pixel script. Source inspection also confirmed that consent-disabled SDK diagnostics omit private page URLs and identifiers during SPA transitions.
- Twilio Flow `FWae6ddf7a2fa835025d6aad8d79ec2e8d` is published at revision 76. Published 72 and drafts 73–75 were backed up privately; the original forwarding properties and phone-number status callback were retained.
- Live dial-action endpoint rejected an unsigned probe with 403 and accepted the correctly signed, zero-duration unanswered-call probe with 200. This did not qualify a conversion or create a call record; no real test calls, customer bookings, or outbound messages were generated.
- Anonymous ad-status access returned 401. An authenticated dashboard check was not performed because verification had no existing human staff session.
- Ads Manager campaign association and a first real attributed booking/call remain unverified. The provider validation-only check and live page event do not substitute for real conversion attribution.


## Measurement limits

Bookings require a confirmed appointment and scheduled start. Phone inquiries use completed connected-call duration of at least 30 seconds and a recent consenting website record for the caller. The existing forwarding Flow does not expose answering-machine detection, so an unrecognized voicemail connection over the threshold can qualify. Anonymous callers without a prior website inquiry cannot be reliably attributed to an ad through the shared number alone.

Provider delivery acceptance does not establish ad attribution. Campaign data-source selection and attributed results require Ads Manager verification. Campaign spend/ROAS reporting requires separate Advertiser API access.
