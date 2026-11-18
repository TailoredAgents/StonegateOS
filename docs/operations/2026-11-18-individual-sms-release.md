# November 18 individual promotional SMS release

Main `46422e354969451fe37a65dfb9498610f72f7b5b` ([PR #10](https://github.com/TailoredAgents/StonegateOS/pull/10)) is live on the API and outbox. Global promotional sending is enabled. Live authenticated MCP verification returns `sendsEnabled: true` and `blockers: []`. Austin explicitly requested enabling sending while leaving the configured number and registration unchanged. The release did not alter either. No customer messages, owner-test SMS, campaign or live draft import were created.

The existing Austin grant now includes `promotional_sms_drafts`, `promotional_sms_preview`, `promotional_sms_release`, and `promotional_sms_status` (41 tools total). Token and expiry remain unchanged. The Facebook outreach project's `STONEGATE_CONNECTION.md` documents current inputs and workflow. Refresh MCP discovery if needed; the existing CLI works immediately.

## Verification

All four required CI workflows passed: [agent integration](https://github.com/TailoredAgents/StonegateOS/actions/runs/44369002539), [individual SMS](https://github.com/TailoredAgents/StonegateOS/actions/runs/44369002492), [Partner Portal production](https://github.com/TailoredAgents/StonegateOS/actions/runs/44369002501), and [E2E](https://github.com/TailoredAgents/StonegateOS/actions/runs/44369002698). Their tested source tree equals the released merge tree.

The real MCP/API/outbox with a simulated SMS provider demonstrated outgoing promotion, inbound customer reply and Jeffrey's ordinary inbox reply in thread `3e5c7797-cb93-4dea-a06d-43af9d0acffb`. Retrying caused zero additional provider sends; newly opted-out contacts were blocked. All 1,318 imported test drafts were fictional. See the [fictional CI proof](evidence/2026-11-18-individual-sms-fictional-proof.json) and [runbook](../runbooks/individual-promotional-sms.md) for schemas, examples and test details.

Live API readiness passed configuration, database, migrations, partner portal, outbox worker and queue checks. Authenticated draft/preview/status discovery passed; unauthenticated administration remained blocked. API/outbox environment differences are limited to the explicitly approved campaign configuration. Pacing is 60 seconds and the conservative segment estimate is $0.02. Consent, opt-outs, quiet hours, capacity, owner test, exact approval and reconciliation remain enforced.

## Website and campaign preparation

The matching website is live on `stonegate-site-sms-20261118`, including the individual campaign, draft-import and qualification screens. Candidate and public checks each passed 26 page/viewport combinations, with no browser errors or horizontal overflow; signed-out login routing passed at mobile and desktop widths. The container image required at least 5,000 MB disk; the gateway follow-up `fe8eb84e` makes disk allocation configurable and this site uses 6,000 MB. Existing deployments retain the 4,000 MB default. Eleven gateway tests passed. Static routing and health monitoring now target the new worker. All 203 existing server actions, the action encryption key and 172 prior immutable assets were preserved. The previous website worker remains available for rollback.

No campaign dates were invented. Austin's agent can prepare the actual campaign terms. Of the 1,318 selected real IDs, 1,278 have final nonempty drafts and 40 remain withheld pending review; original text was not substituted. Recipient evidence and owner approval must be reviewed before importing/sending. The source attestation is not treated as verified consent.

## Operations

The [manifest](../../infra/cloudflare/releases/2026-11-18-individual-sms.json) records deployment IDs and rollback references. Retain additive migration 0186, immutable draft/approval history and dispatch reconciliation records on rollback. API/outbox auto-deploy remains off. Private credentials, source data and raw receipts remain outside Git.
