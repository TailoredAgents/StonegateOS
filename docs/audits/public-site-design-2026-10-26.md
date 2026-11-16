# Public website design audit — October 26, 2026

## Scope and method

Local source audit of 33 public routes at 1440 × 1000 desktop and 390 × 844 mobile. The public blog article template was additionally rendered with explicit local fixture content. The Partner Portal, Team Console, crew application, and private tokenized customer proposals are outside this public-website pass. No production deployment or customer data was changed.

Scores are subjective design judgments, not automated performance scores. The rubric weighs visual hierarchy (20), typography/readability (20), spacing/layout (20), useful imagery and trust (15), consistency (15), and interaction/responsive polish (10). Scores in the 90s mean polished with remaining opportunity; 100 is not asserted.

Across the 33 scored routes, the average desktop score improved from 60.8 to 92.8 and the average mobile score from 53.6 to 92.3.

Before screenshots preserve the first-visit cookie notice. Revised pages were reviewed both with the notice and after rejecting optional cookies; the notice remains equally actionable and is more compact. The full-page screenshots were also inspected beyond the first viewport.

## Page-by-page scores

| Page | Route | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | --- | ---: | ---: | ---: | ---: |
| Home | `/` | 62 | 94 | 49 | 94 |
| Services | `/services` | 60 | 94 | 54 | 94 |
| Pricing | `/pricing` | 72 | 94 | 61 | 92 |
| Service areas | `/areas` | 65 | 93 | 56 | 92 |
| About | `/about` | 58 | 92 | 52 | 91 |
| Gallery | `/gallery` | 51 | 95 | 46 | 94 |
| Reviews | `/reviews` | 55 | 94 | 50 | 94 |
| Contact | `/contact` | 61 | 95 | 52 | 94 |
| Junk-removal booking | `/book` | 68 | 93 | 58 | 93 |
| On-site estimate | `/estimate` | 62 | 93 | 52 | 92 |
| Demolition booking | `/bookdemo` | 66 | 93 | 56 | 92 |
| Blog index (empty state) | `/blog` | 46 | 91 | 42 | 91 |
| Privacy | `/privacy` | 70 | 94 | 63 | 93 |
| Terms | `/terms` | 70 | 94 | 63 | 93 |
| Service agreement | `/service-agreement` | 67 | 93 | 59 | 92 |
| Contractor services | `/contractors` | 76 | 92 | 67 | 91 |
| Rescheduling (missing-link state) | `/schedule` | 60 | 90 | 58 | 91 |
| Appliance Removal | `/services/appliances` | 60 | 93 | 54 | 92 |
| Construction Debris | `/services/construction-debris` | 60 | 93 | 54 | 92 |
| Furniture Removal | `/services/furniture` | 60 | 93 | 54 | 92 |
| Hot Tub Removal | `/services/hot-tub` | 60 | 93 | 54 | 92 |
| Rubbish / small pickup | `/services/single-item` | 60 | 93 | 54 | 92 |
| Acworth | `/areas/acworth` | 58 | 92 | 51 | 92 |
| Alpharetta | `/areas/alpharetta` | 58 | 92 | 51 | 92 |
| Canton | `/areas/canton` | 58 | 92 | 51 | 92 |
| Cherokee County | `/areas/cherokee-county` | 58 | 92 | 51 | 92 |
| Holly Springs | `/areas/holly-springs` | 58 | 92 | 51 | 92 |
| Johns Creek | `/areas/johns-creek` | 58 | 92 | 51 | 92 |
| Kennesaw | `/areas/kennesaw` | 58 | 92 | 51 | 92 |
| Marietta | `/areas/marietta` | 58 | 92 | 51 | 92 |
| Milton | `/areas/milton` | 58 | 92 | 51 | 92 |
| Roswell | `/areas/roswell` | 58 | 92 | 51 | 92 |
| Woodstock | `/areas/woodstock` | 58 | 92 | 51 | 92 |

| Additional template/state | Desktop after | Mobile after | Evidence |
| --- | ---: | ---: | --- |
| Blog index with posts | 94 | 93 | Local fixture; no published-content claim |
| Blog article | 94 | 93 | Local fixture; no before runtime score available |

## What changed

- Added a public-only design system: navy and forest green, warm white, restrained gold accents, softer borders, editorial headings, and consistent spacing. Existing operational themes remain separate.
- Rebuilt the homepage around a clear quote action, services, process, real before/after images, existing customer reviews, the existing quote form, service coverage, and FAQs.
- Improved the header brand lockup, active navigation, keyboard skip link, footer navigation, mobile call/quote bar, chat sizing, and cookie-notice layout.
- Replaced the gallery’s coming-soon treatment with existing customer project photos. Service cards use the established icon library rather than placeholder images.
- Unified all five service pages and all eleven location pages through reusable presentation components while keeping their specific content and metadata.
- Preserved pricing formulas and quote/booking request behavior. Corrected estimate-field label associations and retained recovery behavior.
- Updated the map to the existing 15-mile small-pickup / 25-mile larger-job policy and removed a duplicate Woodstock content bullet.
- Kept legal policy text intact while improving readability.

## Verification

- All 33 local public routes returned HTTP 200 at desktop and mobile sizes; no uncaught browser errors or broken images were recorded in the route capture.
- Responsive checks at 320, 390, 768, 1024, and 1440 px covered home, both booking forms, on-site estimates, pricing, contact, service areas, a service detail, contractors, privacy, and rescheduling; no document-level horizontal overflow.
- Automated WCAG A/AA checks at 390 and 1440 px covered those 11 representative routes. The initial estimate-label findings were repaired and the estimate page rechecked successfully.
- Browser interactions verified mobile navigation and focus restoration, chat opening/closing, pricing keyboard controls and add-on math, booking query parameters, quote steps/results, and estimate error/retry/success. Submission responses were intercepted locally; no real leads, bookings, messages, or payments were created.
- Site typecheck (including Contentlayer generation): passed.
- ESLint on all 36 changed/new TypeScript files: zero errors and zero warnings.
- Final production build: passed; all 102 static pages generated. The intentionally unavailable local API produced handled fetch warnings on data-dependent pages.
- A final production-server browser smoke test could not run: automatic approval review rejected both normal and loopback-only preview startup with “blocked by policy.” Browser evidence above comes from the development preview. The final map-bounds correction was included in the successful build but was not recaptured afterward.

## Evidence and practical limits

Local screenshots and machine-readable results are in `artifacts/public-design/` (ignored build/audit artifacts). `before/` holds the original captures; `after/` holds the revised route captures; `fixtures/` holds blog/article layouts with synthetic data. Later cookie/chat and interaction captures show the final compact mobile chat control. `checks.json` records the initial responsive/accessibility checks, and `interactions.json` records functional browser checks and the successful estimate accessibility recheck.

All imagery and review text came from the existing repository. Professionally composed crew and service-specific photography would be the strongest remaining visual improvement, particularly on About and the repeated service/location templates. Existing job photos have mixed orientations and quality; they are not replaced with invented work.

Runtime data and external providers were not certified. Blog fixture content is not published content, and rescheduling was inspected without a private customer token. The audit preview used a local API address rather than the production API. Changes remain local and are not deployed.

The host uses Node 22.19.0; the repository specifies Node 20.x. Commands reported the existing engine warning.

## Mobile cookie notice follow-up

Following user feedback, the initial cookie notice now uses a short explanation and one row of Accept, Reject, and Settings buttons. Full category details remain available through Settings. At 390 px wide, its measured height dropped from approximately 292 px to 122 px; at 320 px wide it is 137 px. All action buttons retain 44 px tap targets. Browser checks at 320, 390, 430, and 1440 px passed for layout, consent choices, preference persistence, and automated notice accessibility. Captures are saved as `artifacts/public-design/cookie-compact-*.png`. A loopback development preview successfully started for this follow-up at `http://127.0.0.1:3100`.
