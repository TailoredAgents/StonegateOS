# Individual promotional SMS

November 18, 2026. Implement a usable, owner-approved one-contact release using the existing campaign outbox and inbox. No customer sends are authorized by implementation or testing. The owner’s follow-up asks for the feature to be usable when finished, authorizing deployment and activation after local proof. Live recipient import and actual test/customer SMS still need specific approval.

- Preserve individually written copy in immutable versions, with exact contact IDs and a full-file dry-run/import digest. Test 1,318 fictional drafts; do not import the real list during development.
- Preview the exact recipient, configured sender, complete reviewed text, 30% offer, and every hold. Owner action approval binds that snapshot. Each release queues at most one message and returns its real inbox identity/state.
- Reuse campaign consent, DNC, pacing, capacity, quiet-hour, durable dispatch and uncertain-result reconciliation. Add shared-number/thread ambiguity, named and Facebook exclusions, explicit service holds, and rolling 21-day activity checks at release and dispatch.
- Record owner-supplied external evidence references without fetching or copying private evidence. Keep qualification and consent distinct. Agent access cannot attest to its own consent.
- Scope this 30% offer to its recipients. Preserve unrelated 40% campaigns. Use the same saved offer in reply suggestions, quote calculation and booking.
- Prove with the real local database/MCP/inbox routes and a simulated provider: selected draft only, outbound/inbound/staff reply in one thread, retry deduplication, late STOP, changed identity, and provider uncertainty. Document exact tool inputs/results and activation/refresh steps.

## Local completion evidence

- Real MCP/database/outbox/signed webhook proof passed nine groups; 1,318 fictional drafts, same-thread outbound/inbound/Jeffrey reply, retry and late STOP, reconciliation and exclusion checks. No real SMS or live imports.
- Owner preparation UI passed dry-run/import, evidence review, cross-origin rejection and 320/390/1440px layout checks.
- API and Site production builds (including type validation) and targeted lint passed. The broad regression run passed 470 suites with one new route guard-order failure; that guard was corrected and the focused rerun passed all 432 tests across six suites.
- Final rewritten source contains 1,278 usable drafts of 1,318 selected IDs; 40 are explicitly withheld. Local adapter writes a blocked report and never substitutes old copy.
- Production was inspected read-only. Sender exists, but no campaign or promotional verification/rate/test-number setup is configured. No production settings changed.
- Detailed tool contract, evidence and release/refresh steps: [individual SMS runbook](../runbooks/individual-promotional-sms.md).
- The owner’s follow-up authorizes deployment and activation after proof. Live data import and real test SMS still require specific approval. Do not fake provider verification or bypass per-contact holds.
