# November 16 customer-operations agent release

Released from main: website `4d85b70a312aa8f310d7ad0c1864089963e1d067`, API/outbox `cc5edf422260fa6091239df927a0f0c0ddd3f2e1`. [PR #9](https://github.com/TailoredAgents/StonegateOS/pull/9) preserves the previously live release lineage and Jeffrey's work. The website-only follow-up redirects signed-out owners to login while preserving their destination. No customer messages were sent and campaign/sale flags remain off.

## Live connection

Austin's Facebook Outreach connection is installed in the existing trusted desktop project. The real installed MCP client discovered 37 tools and verified stored records, matching, cross-channel context and authentication boundaries against production. The existing company Gmail connection for `austin@stonegatejunkremoval.com` was separately verified for search/read access. Credentials remain private outside Git and OneDrive; PostgreSQL holds only the bearer hash. The grant expires after 30 days and can be revoked at `/team/tools/integrations`.

The handoff is `STONEGATE_CONNECTION.md` in the Facebook outreach folder. Native MCP tools may require the running chat's server to refresh; the installed CLI uses the same live MCP immediately. See the [operator runbook](../runbooks/agent-integrations.md) for tools and action approval. No provider backfill was launched, and contact merges still use the human Merge Queue.

## Verification and limitations

- [Agent integration CI](https://github.com/TailoredAgents/StonegateOS/actions/runs/43963492713), [full E2E](https://github.com/TailoredAgents/StonegateOS/actions/runs/43963492719) and [Partner Portal production journey](https://github.com/TailoredAgents/StonegateOS/actions/runs/43963492773) passed for the final website revision. All three lanes also passed for the API/outbox revision before deployment.
- The real local SDK/PostgreSQL test exercised CRM writes, immutable approval, expiry, duplicate protection, revocation, both campaign audiences and DNC suppression. Production verification found linked Facebook/SMS/call/job history and an unlinked call, and successfully downloaded a message attachment. A production internal-note write was skipped because there was no unique exact owner-email CRM contact; no customer record was modified for testing.
- The latest recording sample found only deleted call records among the recording identifiers inspected. Retained audio download is supported but was not proven with a surviving recording in that sample. Saved transcripts and summaries remain available where present. Imported invalid timestamps and gaps are reported; absent records do not prove no prior contact.
- Candidate and public browser checks each passed 26 page/viewport combinations with no browser errors or horizontal overflow. The compact cookie notice remains intact. Signed-out agent-control navigation was separately verified at 390px and 1440px, with the login return destination preserved.
- The final private image preserves all 203 prior server actions, the existing encryption key and 169 earlier immutable files. It contains 172 immutable files. Build ID: `RQkp8hMWM_k7b_fsBFIT4`.
- API/outbox deployed revisions and unchanged configured environments were verified. Migration `0185_agent_integrations` adds grants, operation receipts and access events. The database remains on Render.

## Operations and rollback

Current website worker: `stonegate-site-agent-final-20261116`. The machine-readable [release manifest](../../infra/cloudflare/releases/2026-11-16-agent-access.json) records exact image/deployment IDs and prior revisions. The static-file router and existing health monitor bind to this worker. Both `stonegate-site-agent-live-20261116` and the earlier `stonegate-site-release-20261116` worker remain available for rollback; preserve their immutable files.

Contain connector problems by revoking the grant or enabling `AGENT_INTEGRATIONS_DISABLED`. Keep authorization, operation and audit records. Roll back the two broad website routes to a prior worker if required, retaining static routes; restore compatible Render deployments from the manifest. Never retry an uncertain outbound operation with a new request key.

Main contains the released application. API/outbox automatic deployment remains off; future releases still require deliberate verification and deployment. The final website correction did not change API/outbox code, so those services retain the already verified connector revision. Older Cloudflare migration pins describe a historical baseline, not authorization to move the database/API/outbox.

Private credentials and raw evidence are outside Git in `~/.local/share/stonegate-agent` and `~/.local/share/stonegate-agent-release-20261116`; only sanitized release metadata is committed.
