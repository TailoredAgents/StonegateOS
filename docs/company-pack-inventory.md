# Company Pack Inventory (Current Hardcodes)

This doc lists company-specific values that are still hardcoded across the repo so we can migrate them into a **Company Pack** (configuration-only) without breaking production.

Primary goal: make onboarding a new company deployment mostly **Import Company Pack + set env secrets** (no code edits) for the CRM + automations.

Note: the public marketing site can be customized or replaced per customer. The built-in marketing site supports build-time branding via `NEXT_PUBLIC_COMPANY_*`, but portability should not require a full in-product website builder.

## Inventory summary (what's currently hardcoded)

### Identity / Branding
- Company name (“Stonegate”) appears in:
  - Site content MDX (`apps/site/content/**`)
  - Site metadata defaults (`apps/site/src/lib/metadata.ts`)
  - Social images (`apps/site/src/app/twitter-image.tsx`)
  - Various UI strings (Sales/Outbound scripts, etc.)

### Phone number (primary business line)
Hardcoded `(404) 777-2631` and `+14047772631` appear in:
- `apps/site/src/components/*` (Header/Footer/Hero/Sticky CTA/Lead forms)
- `apps/site/content/pages/*` (contact/pricing copy)
- `apps/site/src/components/StructuredData.tsx`
- `apps/api/src/lib/policy.ts` (defaults / template copy)
- SEO agent CTA copy (`apps/api/src/lib/seo/agent.ts`)

### Service area (Georgia / North Metro Atlanta)
Hardcoded “Georgia only”, “Georgia above Macon”, “50 miles of Woodstock”, and city lists appear in:
- Policy center UI copy: `apps/site/src/app/team/components/PolicyCenterSection.tsx`
- Lead intake enforcement: `apps/api/app/api/web/lead-intake/route.ts`
- Instant quote enforcement: `apps/api/app/api/junk-quote/*`
- Inbox AI suggest context: `apps/api/app/api/admin/inbox/threads/[threadId]/suggest/route.ts`
- Area pages content: `apps/site/content/areas/*`

### Discounts / pricing messaging
- Discount value is partly configurable via env:
  - `INSTANT_QUOTE_DISCOUNT` (defaults to `0.15`) in `apps/api/app/api/junk-quote/route.ts`
- But “pricing copy” including discount references exists in:
  - `apps/api/src/lib/policy.ts` (template messages)
  - Public chat instructions: `apps/site/src/app/api/chat/route.ts`
  - Website content pages (`apps/site/content/pages/*`)

### Scripts and canned outreach templates
- Outbound script sample mentions “Stonegate” in:
  - `apps/site/src/app/team/components/OutboundSection.tsx`

## Recommended migration approach (safe, incremental)

### Step 1 — Centralize “Company Profile” and “Messaging Templates”
Use existing policy/setting primitives where possible (Policy Center already exists).
- Ensure we have a single authoritative source for:
  - company display name
  - primary phone (e164 + formatted)
  - review link
  - service area mode + allowlist rules
  - discount percent and pricing tiers (as a policy or Company Pack block)

### Step 2 — Replace hardcoded strings with dynamic components
For the site:
- Introduce small UI components like:
  - `<CompanyName />`
  - `<PrimaryPhone />` / `<CallLink />` / `<TextLink />`
  - `<ReviewLink />`
- Update MDX pages to use these components instead of literal values.

For the API:
- Templates should resolve via policy/template functions, not embedded strings.

### Step 3 — Area pages and “custom pages”
Because TA wants template-first with optional custom pages:
- Keep the default set of service/area pages as “template data” (Company Pack website section).
- Allow per-deployment custom pages as content blocks (not code).

## What “done” looks like for Phase 1 (v1)
In a new deployment:
- TA can change company name/phone/hours/service-area/discounts/AI voice without code edits.
- Website pages and structured data reflect the configured company identity.
- Sales/Inbox/SEO messages reflect the configured brand and phone.
