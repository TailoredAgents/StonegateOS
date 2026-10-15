# Outbound inline communication plan

Status: Complete

Started: 2026-10-15

Scope: Partner Outreach Work Queue selected-company workspace

## Outcome

Let an operator call, text, or email the selected prospect without leaving the
Work Queue. The interaction should feel like the existing Team Inbox while the
separate Prospect Inbox remains the place for managing active, reply-driven
conversations.

## Guardrails

1. Reuse the existing call, Inbox composer, thread, delivery, retry, and draft
   safety paths rather than creating a second messaging system.
2. Preserve Do Not Contact enforcement, permissions, idempotency, delivery
   confirmation, and the rule that only completed provider activity counts as
   recorded outreach.
3. Keep company, contact, task, channel, queue filters, and next-prospect state
   explicit in the URL so refreshes never silently switch the operator's work.
4. Do not change imports, production data, provider configuration, campaigns,
   cadence rules, or the dedicated `/mobile` application.
5. Keep Prospect Inbox as the full workspace for ongoing conversations,
   pagination, attention queues, and broader conversation management.

## Phases

1. Add queue-preserving contact, task, channel, and thread navigation.
2. Add a compact communication panel with visible Call, Text, and Email
   controls, recent messages, and the existing durable Inbox composer.
3. Align the outcome-and-continue workflow with the selected contact and task.
4. Verify permissions, missing contact details, Do Not Contact, empty history,
   delivery failures, full-Inbox handoff, and responsive layout.
5. Run focused type, lint, contract, and cross-browser component checks before
   committing and pushing.

## Acceptance criteria

- Email and SMS can be composed and sent from the selected company card.
- Calls start from the same communication panel and remain associated with the
  selected contact and outbound task.
- The panel displays recent history for the selected channel and provides an
  intentional handoff to Prospect Inbox for the full conversation.
- Confirmed calls and delivered messages continue to update the existing
  outreach counts automatically.
- Saving an outcome still advances to the next workable prospect.
- No API, database, migration, provider, permission, or mobile workflow is
  replaced by this UI change.

## Completion record

- Added a queue-preserving contact workspace with visible Call, Text, and Email
  controls inside the selected company card.
- Reused the production Inbox composer, recent-message presentation, failed
  delivery retry, call action, permissions, and Do Not Contact enforcement.
- Kept the full Prospect Inbox as the deliberate handoff for longer history and
  ongoing conversation management.
- Bound contact, task, channel, filters, and optional thread state in canonical
  URLs so refreshes and channel switches retain the operator's place.
- Preserved the existing outcome-and-continue workflow and automatic outreach
  counts. No API, database, provider, import, campaign, or mobile code changed.

## Verification

- Site TypeScript check: passed.
- Focused site lint: passed.
- Outbound test suite: 171 passed.
- Inbox loader/composer/workspace suite: 44 passed.
- Partner navigation and responsive browser suite: 17 passed across Chromium
  and WebKit.
- Live signed-in browser review was unavailable in this workspace, so final
  production visual confirmation remains a post-deploy check.
