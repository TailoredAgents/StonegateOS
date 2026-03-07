# System Docs Pack (AI Briefing)

This folder is meant to be “AI-audit-ready”: you can hand these docs to another model and ask for critiques, efficiency improvements, missing automations, risk areas, and suggested next features.

Start here:
- Summary: `StonegateOS/docs/SYSTEM_OVERVIEW.md`
- “Must never break” flows: `StonegateOS/docs/CRITICAL_FLOWS.md`

## What’s in this pack

### API surface
- Curated API catalog (what matters + auth expectations): `StonegateOS/docs/system/API_CATALOG.md`
- Full route index (apps/api): `StonegateOS/docs/system/API_ROUTE_INDEX_API.md`
- Full route index (apps/site): `StonegateOS/docs/system/API_ROUTE_INDEX_SITE.md`

### Async automation (“outbox”)
- Outbox event index (types → queue sources → handler locations): `StonegateOS/docs/system/OUTBOX_EVENT_INDEX.md`
- Outbox contract (how the queue/worker behaves, retries, idempotency): `StonegateOS/docs/system/OUTBOX_EVENTS.md`

### Data model
- Generated table→columns index: `StonegateOS/docs/system/DATA_DICTIONARY_COLUMNS.md`
- Curated data dictionary (relationships + “what to query when”): `StonegateOS/docs/system/DATA_DICTIONARY.md`

### Configuration / policy
- Policy catalog (keys, shapes, defaults, what reads them): `StonegateOS/docs/system/POLICY_CATALOG.md`
- High-impact env vars by service: `StonegateOS/docs/system/ENV_CATALOG.md`

### Auth / permissions
- Auth + roles + permission gates: `StonegateOS/docs/system/AUTH_MODEL.md`

### Integrations / operations
- Integrations runbook (Twilio, Meta, Google Ads, SMTP, Discord, Render): `StonegateOS/docs/system/INTEGRATIONS.md`
- Debug playbook (common failures, where to look): `StonegateOS/docs/system/DEBUG_PLAYBOOK.md`

### Diagrams
- Sequence + component diagrams (Mermaid): `StonegateOS/docs/system/DIAGRAMS.md`

### Notes
- Known doc gaps + regeneration notes: `StonegateOS/docs/system/KNOWN_GAPS.md`

## How to use these docs with an AI

Good prompts for an external reviewer model:
- “Review the booking and quote funnel for user friction. Propose improvements without adding steps.”
- “Find any duplicated logic across `/book`, `/bookbrush`, `/bookdemo` and recommend refactors.”
- “List production risks (single points of failure, missing retries, missing idempotency checks).”
- “Suggest 10 ‘agentic’ automations that are safe-by-default and approval-gated.”
- “Audit the API surface for inconsistent auth enforcement.”
