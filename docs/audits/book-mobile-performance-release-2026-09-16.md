# Booking page mobile performance release — September 16, 2026

## Release scope

- Release revision: `74c11dca9001cd27280a661ffb03dbd1f484eb26`.
- Branch: `release/book-mobile-performance-20260916`.
- Production base: `b119e5a95ddda0ac8566452c862f9a8abf7591ff`.
- Site service: `srv-d43o7c0dl3ps73a4rb2g`.
- Deployment: `dep-daliup6k1f9s738doa90`, requested at 00:08:04 UTC on September 17 (September 16 in America/New_York).

Seven website source files changed. Upload processing and the alternate quote-result UI load only when needed. The chatbot implementation does not load on a fresh booking-page visit, while navigation within the shared site layout preserves previously loaded chat state. The header requests its displayed 48px logo size with density variants and stops prefetching the homepage from booking pages.

This release was prepared from the exact live revision to preserve the existing production releases. Google, Meta, and OpenAI measurement behavior is unchanged. The separate pending cookie-consent implementation and its privacy-link prefetch change are excluded. No API, worker, database, environment, or service configuration changes were made.

## Verification before deployment

- Frozen-lockfile install, Site type checking, production build using the current public production configuration, targeted ESLint, and diff checks passed.
- Isolated browser tests passed both quote flows, synthetic photo upload, deferred module loading, and scrolling after a deliberately delayed result-module download.
- Production-build browser checks passed at 390px and 1440px, including booking form progression, demolition landing, logo dimensions, chatbot opening, and preservation of chat state across navigation within the shared site layout.
- No real quote, booking, or message was submitted during verification.
- Before deployment, a guard verified the exact pushed revision, unchanged live base, successful browser checks, a clean release worktree, and no other deployment in progress.

## Live performance baseline

A fresh headed Chromium session with normal TLS reached the canonical domain. Lighthouse 12.8.2 mobile emulation measured a score of 77, FCP of 2.69 seconds, LCP of 5.08 seconds, TBT of 74 milliseconds, and zero layout shift. The heading was the largest painted element. Google and Meta accounted for the unused-JavaScript estimate of 138 KiB.

The earlier local score of 98 included pending cookie-consent changes and is not a production result. Production before/after measurements must use the same live-page audit method.

## Deployment outcome

Render confirmed the exact release revision live at 00:12:03 UTC on September 17 (8:12 PM EDT on September 16).

Fresh headed Chromium sessions with normal TLS verified the canonical public `/book` page and its deployed assets. The optimized logo loads at 96px for a 48px display on the emulated mobile device. All 15 loaded first-party JavaScript assets returned 200; none contain the actual chat implementation. No homepage prefetch occurred. No page JavaScript exceptions were captured. The same ad telemetry request failures were present before and after deployment.

Canonical-domain and provider-origin health returned HTTP 200 with `ok`, and anonymous `/mobile` and `/team` requests retained their HTTP 307 login redirects. The canonical-domain checks passed at 00:15:16 UTC using normal TLS after the same intermittent transport issue observed before deployment. No Site error-level logs were returned between release completion and the 00:14:57 UTC log check.

| Live measurement | Before | After |
| --- | ---: | ---: |
| First-party JavaScript transferred | 189,922 bytes | 161,387 bytes |
| Captured subresources transferred | 491,227 bytes | 441,730 bytes |
| Logo transferred | 15,144 bytes | 4,008 bytes |
| Throttled browser LCP sample | 3.52s | 2.35s |
| Lighthouse mobile score | 77 | 71, 72 |
| Lighthouse LCP | 5.08s | 6.88s, 5.83s |
| Lighthouse total blocking time | 74ms | 100ms, 123.5ms |
| Lighthouse layout shift | 0 | 0 |

The deployed assets are smaller, but these live Lighthouse runs do **not** demonstrate a score improvement. One initial post-deployment audit failed with a browser tooling `Target.closeTarget` error and was not used as a score. Both successful post-deployment runs are retained. Production advertising scripts and rendering timing remain significant costs; the local 98 score must not be reported as the live score.

Evidence is retained locally in `artifacts/book-performance/`: `deployment.json`, `release-build.log`, `release-typecheck.log`, `release-shell-checks.json`, the `deploy-baseline*` and `deploy-after*` audits, `deploy-comparison.json`, `deploy-after-asset-proof.json`, and `provider-health-verification.json`, and `live-release-verification.json`.

Rollback target: the previous Site deployment `dep-dald3vvf3r2c738rfa30`, revision `b119e5a95ddda0ac8566452c862f9a8abf7591ff`.
