# Partner service pricing: agreed rates or Quote required

Each service in the eight-service partner setup can now be configured with agreed rates or an explicit Quote required choice. Painting and drywall repair can be offered without invented prices. Unconfigured services still prevent staged account activation; a blank amount alone is not a quote-required choice.

The staff rate editor saves and restores the choice, preserves hidden rate drafts when switching modes, and excludes those rates from publication. Published choices are versioned with the card through additive migration `0181_partner_quote_required_services`. Existing cards default to no quote-required services, and existing request snapshots keep their pricing basis.

The partner catalog and saved requests distinguish Quote required from missing rates. Staff can enter a reviewed amount and reason for a quote-required job without creating a permanent company rate. Real missing rates remain blocked. Per-job prices, existing approval rules, and scheduling guards still apply; the option does not automatically confirm a price or schedule work.

Verification completed locally:

- 58 API unit tests across structured rates, request pricing, service contracts, and catalog projection.
- 26 real PostgreSQL integration tests, including mixed-rate activation, immutable versioned choices, quote-required submission, manual job pricing, rate visibility, and scheduling only after pricing.
- 11 Site catalog parsing tests.
- Four staff setup/partner preview browser cases in Chromium and WebKit at desktop and phone widths, covering save, reload, switching pricing modes, and publication without fabricated rates.
- Four CRM request-review browser cases in Chromium and WebKit, including quote-required painting and drywall totals and failed-save retry preservation.
- API and Site typechecks, scoped lint (no errors; two existing hook-dependency warnings), and diff whitespace checks.

Changes are local in the eight-service implementation worktree. Migration was applied only to a disposable local test database. No deployment, live partner setting, live job, or external message was changed by this task. The previously modified eight-service release audit was preserved.
