# Partner Service details design — September 15, 2026

Status: working local design preview, ready for user review. This design has not been deployed.

## Design

- The large introduction and duplicate bottom jobs link become a compact page heading after the address step. The approved Service address presentation is retained.
- Desktop places service selection and the job description alongside the photo area. Phone layouts use one column.
- Contact/access, special requirements, work-order/billing information, completion-photo preferences and service-specific extras use consistent compact rows. Each row has a clear expand arrow and a useful summary.
- Expanded sections retain their fields and data. Errors open the appropriate section; error-summary links reveal and focus the relevant field. Sections no longer close as required fields are filled.
- Photo selection starts with **Add photos**. Category and note options appear within the selected-photo workflow. Existing upload, finalization, removal and retry behavior is retained.
- The next action reads **Continue to scheduling**. Business rules, service choices, prices, staff confirmation, permissions and API contracts are unchanged by this design work.

## Local verification

- Site typecheck and scoped component/page lint passed.
- All 197 Site portal tests passed, including four new error-focus tests.
- Four actual-component browser cases passed in Chromium/WebKit at 1440px and 375px: conditional service controls, keyboard disclosures, retained field/photo values, fresh validation error reveal, nested billing error focus, and responsive bounds.
- Actual API and Site production builds passed. Two production-build journeys passed at 1440px and 375px against disposable local accounts, PostgreSQL and storage. They covered activation, every tab, first address, draft restoration, a request awaiting staff review, stored photos/messages, optional tools and fresh password sign-in.
- Desktop and phone screenshots of the initial and expanded-contact layouts were captured from the actual local production build and visually reviewed. Separate component previews cover richer service/base-option/add-on data and selected photos.
- The guarded local API omits external delivery configuration and does not dispatch the local outbox. Its general readiness endpoint reports those preexisting local omissions; database, migration and portal readiness are healthy. No production account, provider configuration or customer work was changed.

The required portal workflow now includes the Service details browser checks for a future deployment. No production release or authenticated LandL write journey is claimed by this design preview.
