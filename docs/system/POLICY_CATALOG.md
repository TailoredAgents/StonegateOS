# Policy Catalog

StonegateOS uses a policy/config system to keep company-specific rules out of hardcoded logic.

Primary mechanism:
- DB table: `policy_settings` (`StonegateOS/apps/api/src/db/schema.ts`)
- Reader/helpers: `StonegateOS/apps/api/src/lib/policy.ts`

Secondary mechanism:
- Environment variables (see `StonegateOS/.env.example`)

## How policies are stored
- `policy_settings.key` (string)
- `policy_settings.value` (JSON)
- `updatedBy`, `updatedAt`

Most “core policies” are loaded via `getPolicySetting(db, key)` in `StonegateOS/apps/api/src/lib/policy.ts` and have defaults defined in that file.

---

## Core policy keys (from `policy.ts`)

These keys are read by `StonegateOS/apps/api/src/lib/policy.ts`:

### `service_area`
- Type: `ServiceAreaPolicy`
- Used by: web analytics bucketing, quote intake, “in-area/borderline/out-of-area” decisions.
- Fields:
  - `mode`: `zip_allowlist` | `ga_only` | `ga_above_macon`
  - `homeBase?`, `radiusMiles?`, `zipAllowlist[]`, `notes?`

### `business_hours`
- Type: `BusinessHoursPolicy`
- Used by: availability windows + booking logic + reminders.
- Fields:
  - `timezone`
  - `weekly`: map of weekday → list of `{ start, end }` windows

### `quiet_hours`
- Type: `QuietHoursPolicy`
- Used by: SMS/email/DM timing to avoid late-night sends.
- Fields:
  - `channels`: `{ sms: {start,end}, email: {start,end}, dm: {start,end}, ... }`

### `templates`
- Type: `TemplatesPolicy`
- Used by: confirmation/follow-up/review templates by channel.
- Fields:
  - `first_touch`, `follow_up`, `confirmations`, `reviews`, `out_of_area` (each is channel→template string)

### `review_request`
- Type: `ReviewRequestPolicy`
- Used by: post-job review automation.
- Fields: `enabled`, `reviewUrl`

### `standard_job`
- Type: `StandardJobPolicy`
- Used by: job evaluation (“is this in standard bounds?”) and booking assist rules.
- Fields: `allowedServices[]`, `maxVolumeCubicYards`, `maxItemCount`, `notes?`

### `item_policies`
- Type: `ItemPoliciesPolicy`
- Used by: quote guidance and “declined items” / extra fees.
- Fields:
  - `declined[]`
  - `extraFees[]`: `{ item, fee }`

### `booking_rules`
- Type: `BookingRulesPolicy`
- Used by: booking window rules, buffers, and daily capacity rules.
- Fields: `bookingWindowDays`, `bufferMinutes`, `maxJobsPerDay`, `maxJobsPerCrew`

### `confirmation_loop`
- Type: `ConfirmationLoopPolicy`
- Used by: confirmation reminder loop behavior.
- Fields: `enabled`, `windowsMinutes[]`

### `follow_up_sequence`
- Type: `FollowUpSequencePolicy`
- Used by: follow-up cadence.
- Fields: `enabled`, `stepsMinutes[]`

### `conversation_persona`
- Type: `ConversationPersonaPolicy`
- Used by: AI persona/system prompt for drafts/suggestions.
- Fields: `systemPrompt`

### `company_profile`
- Type: `CompanyProfilePolicy`
- Used by: messaging voice, pricing summary, and AI “business facts”.
- Fields include:
  - `businessName`, `primaryPhone`, `discountPercent`
  - `serviceAreaSummary`, `trailerAndPricingSummary`
  - `whatWeDo`, `whatWeDontDo`, `bookingStyle`
  - `agentNotes`, `outboundCallRecordingNotice`

### `sales_autopilot`
- Type: `SalesAutopilotPolicy`
- Used by: inbound→draft/autosend behavior, escalation timing.
- Fields:
  - `enabled`
  - `autoSendAfterMinutes`, `activityWindowMinutes`, `retryDelayMinutes`
  - `dmSmsFallbackAfterMinutes`, `dmMinSilenceBeforeSmsMinutes`
  - `agentDisplayName`

### `inbox_alerts`
- Type: `InboxAlertsPolicy`
- Used by: lead/inbox alert routing by channel.
- Fields: `sms`, `dm`, `email`

### `google_ads_analyst`
- Type: `GoogleAdsAnalystPolicy`
- Used by: automated reporting/recommendation guardrails.
- Fields: `enabled`, `autonomous`, `callWeight`, `bookingWeight`, `minSpendForNegatives`, `minClicksForNegatives`

---

## Additional `policy_settings` keys (outside `policy.ts`)

Some configuration is stored in `policy_settings` but read by other modules:

### `team_member_phones`
- Used by: mapping team member IDs to phone numbers for call routing / identification.
- Reader: `StonegateOS/apps/api/src/lib/team-auth.ts`

### `contact_assignees_v1`
- Used by: explicit contact→assignee overrides.
- Reader/writer: `StonegateOS/apps/api/src/lib/contact-assignees.ts`

### `sales_scorecard`
- Used by: Sales HQ scorecard settings and “speed to lead” metrics.
- Reader: `StonegateOS/apps/api/src/lib/sales-scorecard.ts`

---

## Environment overrides (common)

Some settings can be overridden by env vars (see `StonegateOS/.env.example`), for example:
- `INSTANT_QUOTE_DISCOUNT`, `INSTANT_QUOTE_DISCOUNT_JUNK_AMOUNT`, `INSTANT_QUOTE_DISCOUNT_DEMO_AMOUNT`
- `APPOINTMENT_CAPACITY`
- `SALES_ESCALATION_CALL_ENABLED`, `SALES_AUTO_FIRST_TOUCH_SMS_ENABLED`

