# Booking page mobile performance — September 16, 2026

Optimized `/book` without changing the quote or booking workflow. The final local production build scored 98 in a mobile Lighthouse run, with 22% fewer downloaded subresource bytes than the local baseline.

The baseline already included pending cookie-consent and advertising changes present in the workspace before this task. It scored 95. These measurements compare local production builds; they do not establish a production improvement from the user's PageSpeed screenshot score of 67. Both live hostnames failed TLS from this workstation. Deployment and live audit results are recorded separately in [the production release report](book-mobile-performance-release-2026-09-16.md); the production release excludes the separate pending consent work.

## Changes

- Load photo/video processing only when files are selected.
- Load the alternate contact-first quote result only after a quote response. Scroll to the result after the component mounts, including on slow connections.
- Keep the chatbot implementation out of an initial booking-page load. Preserve its mounted state after loading it on another page in the shared site layout.
- Request the header logo at its displayed 48px size instead of 80px; Next.js still supplies density variants.
- Disable automatic homepage prefetch on booking pages and privacy-policy prefetch in the cookie notice. Both links continue to navigate normally.

## Controlled measurements

Next.js 15.5.5 production builds, Lighthouse 12.8.2 mobile defaults, same local machine and URL (`http://127.0.0.1:3100/book`). Scores and timings vary between runs; byte reductions are the more stable evidence.

| Measurement | Local baseline | Final build |
| --- | ---: | ---: |
| Performance score | 95 | 98 |
| First contentful paint | 0.92s | 0.91s |
| Largest contentful paint | 2.95s | 2.40s |
| Total blocking time | 26ms | 8ms |
| Cumulative layout shift | 0 | 0 |
| Downloaded JavaScript, including automatic prefetch | 186,760 bytes | 163,481 bytes |
| Downloaded subresources | 245,630 bytes | 191,050 bytes |
| Logo download on emulated mobile | 15,144 bytes | 4,008 bytes |
| Subresource requests | 21 | 16 |

The cookie-notice paragraph remains the largest painted element and appears after hydration. No optional marketing scripts loaded before consent in either local build. The final booking load made no homepage/privacy prefetch requests.

## Validation

- Production build, including TypeScript validation, passed.
- Targeted ESLint and `git diff --check` passed.
- All 18 existing consent, tracking, and OpenAI attribution unit tests passed.
- Isolated mobile browser checks with mocked APIs passed the standard and contact-first quote flows and photo upload. They verified deferred chunk loading and scrolling with a deliberately delayed result chunk. No real quotes, bookings, or messages were created.
- Production browser checks covered mobile and desktop booking forms, the demolition page, logo sizing, chatbot opening, and conversation state during navigation within the shared site layout.

Raw reports and browser evidence are in the ignored `artifacts/book-performance/` directory: `baseline.report.json`, `final-verified.report.html`, `final-verified-comparison.json`, `site-shell-checks.json`, and the browser-check scripts.
