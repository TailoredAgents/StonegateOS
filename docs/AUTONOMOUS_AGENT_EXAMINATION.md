# Autonomous Sales Agent Examination

Last updated: 2026-06-14

## Current Confidence

- Overall E2E functionality: 84/100
- Conversational ability: 75/100
- Booking capability: 81/100
- Safety/guardrails: 93/100

These scores are based on the executable examination tests, API build, and a read-only live database audit. They should be treated as controlled-autonomy confidence, not final live-smoke confidence, until a real internal SMS/DM booking test completes.

## What Was Examined

- Kick-in path: inbound SMS/DM records `message.received`, outbox queues `facebook.sales.evaluate`, and the sales closer evaluates the thread.
- Autonomy guard: Mon-Sat `6:30 PM-7:30 AM`, Sunday all day, daytime downgrade to assist/draft.
- Conversation flow: missing quote details, ballpark range, free in-person quote offer, explicit slot confirmation, human-review fallback.
- Booking rules: 60-minute jobs, Sunday blocked, weekday/Saturday windows, approved-city `5:30 PM` exception, and night-agent `10:00 AM+` minimum.
- Production readiness: policy rows, automation modes, outbox backlog, recent actions, provider health, and recent sales-autopilot bookings.

## Live Audit Findings

- Passing: `business_hours` policy is configured.
- Passing: `sales_autopilot` is enabled in full mode for SMS and DM.
- Passing: `automation_settings` has `sms=auto` and `dm=auto`.
- Passing: no stuck target outbox events older than 10 minutes.
- Passing: recent autopilot actions show no recorded errors.
- Passing: SMS provider health is currently successful.
- Warning: calendar provider health still shows the last calendar check as failed with `calendar_create_failed`.
- Warning: no `sales_autopilot` appointment bookings were observed in the last 7 days.
- Warning: recent closer actions in the database are still from prior `shadow` mode traffic, so a fresh live auto-mode smoke test is still required.

## Commands

Run the deterministic examination tests:

```bash
corepack pnpm --filter api test -- --runTestsByPath src/__tests__/autonomous-agent-examination.test.ts src/__tests__/after-hours-autonomy.test.ts src/__tests__/facebook-sales-autopilot.test.ts
```

Run the API build:

```bash
corepack pnpm --filter api build
```

Run the read-only database audit:

```bash
DATABASE_URL="$DATABASE_URL" corepack pnpm tsx scripts/autonomous-agent-audit.ts
```

The audit exits with code `2` if hard readiness checks fail. Warnings do not fail the command.

Run the Jerry SMS smoke audit:

```bash
corepack pnpm tsx scripts/sms-agent-smoke-audit.ts --phone="$SALES_AUTONOMY_TEST_PHONE_E164"
```

Temporary daytime smoke override:

```bash
SALES_AUTONOMY_TEST_PHONE_E164=<approved internal test phone in E.164 format>
SALES_AUTONOMY_TEST_FORCE_AFTER_HOURS=1
```

This override is intentionally narrow: it only forces auto mode for the configured test phone and still passes an after-hours timestamp into booking assist/booking so the `10:00 AM+` after-hours booking rule is exercised. Disable it immediately after the SMS smoke by setting `SALES_AUTONOMY_TEST_FORCE_AFTER_HOURS=0` or removing both variables.

## Remaining Live Smoke

Use internal/test contacts only:

- After-hours SMS quote request should collect fields, quote, offer slots, book, and confirm.
- Facebook DM quote request should run the same flow.
- Sunday inbound should get an autonomous reply but never book Sunday.
- Night inbound should never offer/book before `10:00 AM` next service day.
- Risk keyword should create a human-review task and send no customer-facing reply.
- DNC or human takeover should prevent outbound automation.
- Calendar sync must be verified healthy before trusting automatic booking.
