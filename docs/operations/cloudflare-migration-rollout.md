# StonegateOS Cloudflare rollout plan

Prepared November 15, 2026 (America/New_York); evidence updated November 16 UTC.

Status: authorized execution is underway on `codex/cloudflare-migration` in an isolated worktree. Production traffic, application consumers and PostgreSQL remain on Render. No production DNS cutover, provider messages, payments or database retirement have occurred. Recovery, media, Cloudflare runtime and read-only source connection trials have completed; application integration and cutover gates remain open.

Private receipts and credentials are held outside this public repository under `~/.local/share/stonegate-migration`. Never commit those files, database dumps, object keys or customer records.

## Execution receipts — November 15

| Check | Observed result | Remaining limit |
|---|---|---|
| Consistent encrypted PostgreSQL export and isolated restore | 230 tables and 200,984 rows; zero unexplained content/schema differences | Snapshot is a rehearsal, not the final synchronization boundary |
| Database objects | On both recovery providers, 126 functions and 115 triggers match exactly; no views. PlanetScale has 1,202 matching owned objects and 1,610 grants after explicit owner-name mapping; zero invalid indexes | Production application roles remain to be configured; final sequence comparison requires the write freeze |
| PlanetScale replacement rehearsal | PG17.12, 230 tables / 200,984 rows restored and reconciled in 213.045 seconds; zero unexplained differences; snapshot sequence value also matches | Timing covers restore and verification only, excluding final export, traffic handoff and rollback margin |
| Cloudflare to PlanetScale | Two actual-API cycles passed ten checks each: direct verified TLS, wrong-name rejection, role-enforced write denial, same-pool recovery after backend termination, migration journal and auth rejection. Four connections completed 80 reads per cycle (p95 175/181 ms) | Read-only recovery copy and synthetic API secrets; these are connection checks, not representative production capacity tests |
| Source writer-fence rehearsal | 13 checks passed on isolated Render scratch data with a nonprivileged role: credential rotation, surviving-session demonstration, session termination, committed-row preservation, unfinished transaction rollback and pre-promotion rollback | Source credentials remain unchanged. Actual dispatcher drain and final end-to-end freeze timing are separate gates |
| Media | 206 R2 objects readable and SHA-256 hashed; 203 active database references checked, zero findings | Phone-local unsynced queues still require inspection before cutover |
| Native Cloudflare runtime | 31 checks passed across `63fa9da7` API/outbox/Discord and the private site image, including restarts, native libraries and real Discord drain | Production consumers have not moved; cold starts took roughly 48–73 seconds and require warm readiness before routing |
| Actual Next.js runtime | Nine page/asset/health checks passed in the private Cloudflare image; all 14 public settings match; all 115 legacy assets match | This native trial is distinct from the authenticated coupled trial below |
| Durable webhook journal | 27 live checks pass: signed exact-byte persistence before ACK, 20 concurrent duplicate submissions, 200 kB payload, replay verification and controller death after downstream commit | Synthetic signing secret and in-account receiver only; real handler idempotency, call-flow ACK semantics and ingress routing remain cutover gates |
| Full HTTP gateway transport | 50 live checks pass across two warm/activate/drain cycles: auth/cookies/query/signed bytes, true streaming, exact 20 MiB uploads, lost write response without retry and accepted-write drain | Isolated fixture backend; no production routes or customer credentials. Native transport derives Host from the request URL; corrected and retested |
| Website candidate controller | 32 live checks passed across two starts/stops: real Next entrypoint, fixed public pages, concurrent proxy reads, exact private image, all 115 legacy assets, route/auth rejection and cleanup | Bearer-protected candidate only; no public traffic, customer cookies or business mutations admitted |
| Private Worker SQL | Five consecutive reads matched restored table counts through Hyperdrive and Tunnel | Private IP works; internal hostname path failed. Certificate verification is disabled for this isolated restore trial and must be resolved for production |
| Verified Container SQL | Six read-only TLS queries across two Container restarts; wrong certificate identity rejected; deliberate relay outages fail closed and the same pool reconnects in both cycles | Access service token expires November 22; real application reads and rotation still need validation |
| Verified Cloudflare source connection | Ten checks in each of two cycles passed against the original database: strict TLS, SELECT-only reads, relay interruption/reconnection, certificate-name rejection and actual API readiness/journal reads | Diagnostic role only; no customer rows returned, production writes or provider credentials exercised |
| Source connection isolation | Anonymous, wrong-secret and restore-credential requests rejected; dedicated source credential accepted; zero writable tables/sequences/privileged functions for the expiring probe role | Source role expires November 22 at 22:00 UTC; credential rotation and production application credentials remain separate gates |
| Actual API runtime | Database readiness, migration journal and unauthorized-admin rejection pass across two Container restarts at 2 GiB / 1 vCPU, with relay failure/recovery tests | A 1 GiB / 0.25 vCPU trial timed out on its second restart; no customer mutations/providers were exercised |
| Idle controller lifecycle | Same network-isolated Container remained healthy across multiple Durable Object executions and a scheduled health alarm | A bounded diagnostic proves lifecycle behavior, not production billing or background-consumer recovery |
| Existing regression suites | Quote and Expense follow-up passed on PG17/Node24; Partner Portal production journey passed | Browser-core run `43786397165` now passes; remaining provider-positive and production cutover checks are separate |
| Outbox signal drain | Real worker on disposable PG17/Node24 exited cleanly in 37 ms; two-event test verified stopped batch admission, preserved retry budget and exactly-once resumption (`43777488505`) | Source Render worker does not yet contain this handler; handoff must explicitly stop and fence it |
| Focused Inbox/mobile regression | All 14 checks passed in run `43773335723`, including directory failure/retry and successful booking | Other browser failures remain under investigation |
| Empty synthetic database | 230 tables, 181 migration journal entries, zero application rows; TLS verified; separate nonprivileged owner | Cloudflare write and consumer trials use this database only |
| Synthetic API writes | Two Cloudflare cycles passed real principal-scoped contact creation, audit persistence, restart persistence and token revocation | Synthetic records only; production credentials are absent |
| Synthetic bookings | Two cycles passed durable booking creation, replay after restart, unchanged outbox count and conflicting-key rejection; subsequent delivery fixtures also pass | Repeated fixtures use separate dates so they do not exhaust the same capacity window |
| Synthetic outbox delivery | Two cycles passed 16 checks each at 1 GiB with a batch limit of 50 and local SMS/SMTP simulators; in-flight email drained in 3.613/3.615 seconds, no dispatch began after stop, and restart preserved delivery counts | Synthetic traffic establishes correctness at this allocation, not peak production capacity |
| Coupled Cloudflare site/API | Latest images passed 21 checks in each of two cycles: real session-cookie verification, directory permissions/cache, committed contact reads, restart persistence and revoked-session rejection | Synthetic identities only; full browser and production routing gates remain open |
| Interrupted delivery | One earlier forcibly stopped synthetic email remains explicitly uncertain and was not retried in either successful cycle | It remains preserved for reconciliation; this is not a successful delivery claim |
| Off-device key recovery | GitHub secret escrow recovered through RSA-OAEP encryption; recovered key authenticated the real encrypted backup metadata in run `43777328873` | Applies to `recovery-20261115-v2`; each future backup/key needs its own recovery receipt |
| Scheduled baseline observation | Fifteen observation receipts, including fourteen scheduled runs, through 02:30 UTC November 16; zero failed checks, stale collection or gaps | Health checks do not validate positive business/provider flows or guarantee continued agent execution |
| Production health and access rejection | 13 live checks passed; unsigned Twilio callbacks rejected | Positive provider scenarios require controlled staging fixtures/sandbox credentials |

The restore verifier canonicalizes CHECK expressions using the restore server's PostgreSQL parser and compares enum label order independently of PostgreSQL's internal fractional ordering numbers. Seven equivalent CHECK renderings were accounted for; row contents were not normalized away. Sequence values are not MVCC and are not claimed to match a live source snapshot.

The candidate images preserve different live revisions per service. Authenticated Render SSH confirmed Node 24.22.1 for the website and 24.21.0 for API, outbox and Discord. Build run `43773277476` and image-transfer run `43773734486` passed for candidate `5dcec1af`, which subsequently passed all 29 native and seven real-site runtime checks. Each image includes the SHA-256-recorded database TLS servername compatibility patch. The outbox image additionally includes graceful signal drain; the website image includes the Inbox booking directory fix discovered by the baseline audit. Patches apply only to their declared services. The website build contains all 14 captured public configuration fields. A source comparison confirms that API production code at its pinned revision matches the baseline; six differing API files are test-only. The older outbox revision intentionally retains its existing application/schema differences. Initial images without that configuration are superseded. Candidate `d55f0ec7` additionally stops admission between events within a selected batch. Its build (`43777488375`), registry transfer (`43777983715`), 29 native checks, seven real-site checks, full-batch delivery and coupled site/API trials all passed. Database and lifecycle diagnostics still run their earlier images; their local configurations are prepared for the new digest but are not claimed redeployed.

The Container SQL trial uses the official `cloudflared access tcp` client, a service-token-only Access policy and the private Render connector. The client trusts Node roots plus Cloudflare's provided Container CA. PostgreSQL separately verifies an explicitly pinned certificate obtained over authenticated Render SSH, including its server identity. All query credentials belong to a non-superuser SELECT-only restore role; no production database credentials enter the trial. The earlier Hyperdrive trial with certificate verification disabled remains diagnostic only. The source database certificate was independently pinned over authenticated SSH and verified with strict TLS in a read-only transaction at 00:11 UTC November 16. Source PG17.9 has `wal_level=replica`; logical replication is not currently available. The subsequent `stonegate-source-readiness` Container trial passed two complete actual-API/read-only cycles against the source through its own Access application and service token. It uses the latest API image, verifies the deployed probe hash, and stops after testing. The restore-only credential is explicitly denied at the source endpoint. The database role has no table writes, sequence writes or executable security-definer functions and expires on November 22; production application owner credentials were not copied into this Worker.

The broad baseline audit (`43763531179`) was stopped near its time limit after capturing failures. Its core browser setup rejected a too-short synthetic admin-session secret. API tests reported 4,234 passing, 193 skipped and three failed source-contract assertions (formatting, an extracted message component, and a sidebar CSS scope). Portal audit paths also encountered disabled feature configurations and UI assertion failures. These are not successful migration checks. After fixture/contract corrections, run `43769726286` passed all pre-browser lanes. Core browser results were 35 passed, 11 failed and 102 skipped after the fail-fast limit, including in-flight failures. Remaining failures include obsolete legacy-admin authentication, URL query ordering, mobile UI expectations, confirmation email matching, draft payout report generation and legacy quote actions. Focused reruns are tracked on this branch. The browser lane was discovered still using PG16 via Docker Compose; its version is now explicitly connected to the PG17 workflow input. Production application behavior is unchanged.

Run `43771495687` passed 13 of 14 focused checks after correcting authentication and URL ordering. The remaining failure revealed that `InboxView` passed an empty team directory into booking. The site patch now loads the directory on drawer open with authenticated `appointments.read` access, a loading state and failure/retry handling; run `43773335723` passed all 14 checks. Follow-up fixtures use actual weekly payout boundaries, complete mutation receipts, current status colors/media labels and a wait for quote availability. Run `43774254756` passed 11, failed four and skipped six. Run `43775931454` then passed both mobile final-total checks; confirmation email and quote navigation still failed. Mail artifacts proved the OpenAI simulator was substituting an email address for `email_body`/`email_subject`, rather than losing mail. Its notification fixture is corrected in `6a67eb97`; run `43777190812` passed the confirmation email check. The quote fixture then hit the real evening quiet-hours rule before reaching browser navigation. Disposable E2E seeding now disables quiet hours only in its guarded test database. Run `43778680501` stopped at stale generated documentation; the index was refreshed. Run `43779628305` reached delivery: the email arrived, but quoted-printable MIME folded the URL and the raw-string matcher timed out. The MailHog helper now decodes transport encoding before content assertions, with a regression test for folded URLs, UTF-8, base64 and plain text. Run `43781210205` passed the remaining quote journey. The quote booking API returned the confirmed redirect in the failed navigation trials; that alone does not establish a successful customer browser journey.

The quote journey completed successfully in run `43781210205`. The broader browser run `43782275558` passed pre-browser checks and 78 browser checks, then reported nine failures, two interrupted checks, 37 skipped and 22 not run. Traces exposed incomplete mocked manual-payment receipts, outdated mobile labels, an invalid-Square-return expectation and missing isolated payout fixtures. Run `43785106826` passed ten targeted mobile checks across Chromium and WebKit: real cash/check mutation routes, invalid callback rejection, photo upload/finalization and unsynced-photo recovery after the job snapshot expires. Two remaining payout/editor checks failed; their exact selector and fixture setup were corrected. Full browser-core run `43786397165` then passed 109 browser checks, with all pre-browser lanes passing: 4,238 API tests, 516 partner API tests and 1,055 partner site tests. Intentionally skipped tests are not counted as passing. None of these synthetic browser tests prove that every real staff phone has synchronized.

Website continuity uses a separate private image. The existing Render server-action encryption key must never enter the public GHCR image packages. Private build `43785077172` verified all 202 existing server-action identifiers and the same encryption key, then preserved all 115 old static files (4,139,217 bytes). The private Cloudflare image digest is `sha256:294a427e1a4daa248110f8415f4b555644a68ffd368a9faf4f8e5dfc7029485b`. The archived public assets passed authenticated upload/download and SHA-256 checks, and unauthenticated archive access returned 401. Four temporary GitHub build credentials were removed after publication. Subsequent Cloudflare serving checks verified every old asset hash. The candidate controller also passed two complete starts/stops and concurrent read-only page requests; both starts took about 3.7 seconds with the image already prepared. These are not cold image-placement timings or production observation.

Candidate `63fa9da7` builds and transfers all four public diagnostic images successfully (`43782725481`, `43783140825`). The Discord image includes its direct Luxon dependency and an actual entrypoint drain test: a fake gateway and blocked provider traffic demonstrate accepted work finishing before disconnect, with later events rejected. The website runtime checks use the private continuity image above. All 15 local migration regression tests pass on Node 24.21.0.

The latest deployed image set also passed both synthetic cycles for API writes (nine checks per cycle), booking preparation/replay (14), outbox delivery and graceful drain (16), and coupled website/API sessions (21). The deliberately uncertain synthetic email remains preserved. The same API image passed ten source-readiness checks in each of two read-only cycles, including relay outage/recovery and invalid-certificate rejection. A separate bounded website lifecycle trial kept the same healthy real Next.js Container across controller recreation and a health alarm, then stopped it successfully. These are staging receipts; normal-day production observation has not begun.

The read-only writer inventory found six login roles, with application-table write privileges held by the shared application owner and Render's platform superuser. API, outbox and Discord resolve to the same application owner and source database. The application owner lacks `CREATEROLE` and `CREATEDB`, so final fencing must use capabilities actually available on the managed service rather than assuming superuser access. The snapshot found two client sessions, zero prepared transactions, zero large objects and zero logical replication slots; `wal_level=replica`. Re-run this inventory immediately before handoff. No source login was altered, no source session terminated and no source write fence activated. The separate `writer-fence-validation.mjs` rehearsal uses a disposable role/database on the recovery server. It passed all 13 checks in 5.483 seconds. Deliberate backend termination initially exposed a `postgres` 3.4.4 driver error; the migration tooling now pins 3.4.7 (already used by the API), and the complete rehearsal passes. Both scratch databases/roles were inspected and removed; the restored customer snapshot was preserved.

Read-only Twilio inventory resolves exactly one number from the deployed Stonegate sender; three other account numbers are outside this migration. Stonegate's published Studio flow has four states: forward the inbound call, then send a call-completion HTTP request and one retry. Its SMS URL, call-status URL and both Studio HTTP callbacks still use `stonegate-api.onrender.com`. Preserve the full callback URLs, query parameters, signature configuration and active call behavior during migration. No Twilio configuration or messages were changed. `pnpm exec tsx scripts/migration/provider-inventory.mts <private-directory>` records a project-scoped private snapshot and SHA-256 to detect drift before a later callback update. See [Twilio IncomingPhoneNumber configuration](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource).

Temporary resources (prorated; additional to unchanged production hosting):

| Resource | Identifier | Cost / scope |
|---|---|---|
| Private restore PostgreSQL | `dpg-dbt21dui0phs73efick0-a` | Basic 1GB + 5GB storage, about $20.50/month equivalent |
| PlanetScale replacement standby | `stonegate-os-pg17`, branch `main` | PG17.12 PS-10 ARM, one primary in Virginia, 15 GB minimum/maximum storage; $11/month quoted, billed through Cloudflare |
| Render Tunnel connector | `srv-dbt2abt6e07s73b7ps30` | Starter, $7/month equivalent; automatic deploy disabled |
| Cloudflare Tunnel | `e1e17afc-ff6e-4a8d-a7ef-a83d6c0d645d` | QUIC; separate Access-protected source-readiness and restore TCP routes |
| Zero Trust / Access | `migration-db.stonegatejunkremoval.com` | Free plan activated, $0/month; seven-day service credential, one restrictive Service Auth policy |
| Source-readiness Access | `migration-live-db.stonegatejunkremoval.com` | Separate application `d6b804e0-aa63-4643-8e9e-7c30660953ef`, exact-token Service Auth policy; seven-day credential |
| Restore VPC service | `01a1e122-4780-75b2-9926-b159cbdfad10` | Restricted destination TCP5432; temporary private IP |
| Read-only restore Hyperdrive | `b449cf5370d34f62aaa57be60980a710` | Caching disabled; origin connection limit five |
| Diagnostic Workers | `stonegate-migration-validation`, `stonegate-container-validation`, `stonegate-database-validation`, `stonegate-lifecycle-validation`, `stonegate-synthetic-validation`, `stonegate-source-readiness`, `stonegate-target-readiness`, `stonegate-site-candidate`, `stonegate-migration-assets`, `stonegate-http-gateway-validation`, `stonegate-webhook-journal-validation` | Bearer protected, bounded diagnostics; metered usage |
| Encrypted recovery R2 bucket | `stonegate-migration-backups` | Public access disabled; encrypted dump and catalog/manifest uploaded, downloaded and integrity checked |
| Synthetic R2 bucket | `stonegate-migration-validation` | No public domain; isolated PUT/GET/DELETE trials |

Do not treat the $38.50/month equivalent overlap (Render recovery $20.50, Tunnel $7, replacement standby $11) as savings. Original services are still billed. Validation Containers are stopped after tests. Synthetic and lifecycle Containers have a 180-second idle limit; other diagnostics use 60 seconds. The replacement is provisioned for rehearsal and has no production writers or traffic. Two migration CNAMEs were added, one for restore tests and one for source readiness. Before adding the second, all 18 existing records were captured and compared unchanged afterward; the original 17 production records remain unchanged.

The `stonegate_staging_20261115` synthetic database shares the temporary restore server, adding no separate Render instance. It contains schema and migration history only before the application trials; subsequent records are synthetic. Its role is separate from the SELECT-only recovery role. The Cloudflare/PlanetScale billing connection has a $0 base fee. The separate `stonegate-os-pg17` project was provisioned at 02:11 UTC November 16. Its isolated `stonegate_restore_20261116` logical database contains the verified recovery snapshot. The original encrypted archive and its existing escrowed key were reused, preserving the same comparison baseline. Client-to-provider TLS 1.3 certificate verification and wrong-hostname rejection both pass; the provider terminates TLS at its proxy, so backend `pg_stat_ssl` is not evidence of client TLS. The target reports 25 maximum connections and approximately 328 MB for the restored logical database. Its expiring diagnostic role can SELECT all 230 tables but has zero writable tables/sequences, no elevated role flags and no executable security-definer application functions. The administrative restore role is not an application credential.

The first PlanetScale managed backup, `migration-restore-verified-20261116`, completed at 227 MB and is retained for seven days. A separate `migration-seven-day-recovery` schedule now runs every 12 hours with seven-day retention, extending the provider's default two-day window. Restoring this backup and verifying recovery on the replacement provider is still in progress. Custom retention can consume billed backup storage above the included 30 GB. See [PlanetScale backups and recovery](https://planetscale.com/docs/postgres/backups).

The synthetic validation client checks the deployed probe's SHA-256 against its local source before accepting results. These diagnostics use immediate Durable Object code adoption and are deployed only when no test is active. Cloudflare otherwise defaults to deferring an active object's update for up to five minutes. Production deployment orchestration must coordinate version adoption and in-flight work explicitly; see [Durable Object code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/). Tests that forcibly terminate a provider operation retain its uncertainty record. They never reset that state to manufacture a passing result.

The validation Worker's bounded cron records six public GET statuses/timings in the private synthetic R2 bucket every 15 minutes. It discards response bodies and does not invoke provider callbacks. Checks stop at `2026-11-22T22:00:00Z`; remove the cron configuration at cleanup to avoid subsequent no-op invocations. `node scripts/migration/health-observations.mjs <private-directory>` exports receipts and reports failures, stale collection and gaps. This schedule observes health only; it cannot promote a deployment, freeze writes or retire a database.

Current next gates:

1. Keep the passing PG17/Node24 browser-core and focused Inbox/mobile receipts tied to their artifacts; verify remaining positive provider deliveries using designated test destinations.
2. Complete token/certificate rotation and production credential configuration. Source and restore SQL paths already pass relay interruption, pool reconnection and certificate-name rejection.
3. Extend the passing coupled API/site, booking and full-batch consumer trials to the remaining provider and browser scenarios, preserving the per-service deployed revisions.
4. Finish authenticated application/provider staging flows, consumer drain/fencing, durable webhook handling, and rollback rehearsal.
5. Only then move traffic and begin the observation windows below. There is no unattended production cutover or retirement timer armed.

## Objective and operating decisions

Move all four StonegateOS application services to Cloudflare while they continue using the existing Render PostgreSQL database. Stabilize that arrangement. A separate managed PostgreSQL replacement has been provisioned for rehearsal. After service stabilization, refresh and reconcile all application data there, complete a controlled writer handoff, and retain the old database before retirement.

Success means zero lost committed records and zero lost acknowledged incoming events, no migration-induced duplicate financial or communication effects, preserved media and unsynced phone work, functioning integrations, tested recovery, and measured hosting cost. No phase is considered successful solely because deployment or a backup command completed.

Working rollout defaults following the user's instruction to proceed:

- Migrate the currently deployed behavior. Keep the 155 changed/untracked working-tree paths separate.
- The validated candidate uses Containers for all four services behind Workers; a direct Workers website adapter remains an optional later optimization requiring its own parity evidence.
- Retain the public website origin and existing R2 bucket names/object keys.
- Keep PostgreSQL. PlanetScale's Cloudflare integration is provisioned as the replacement candidate; PG17 and extension/data parity pass. Recovery and representative capacity remain promotion gates.
- Treat $55–75/month as an optimization target only. The current conservative Container fallback models approximately $90–106/month with the temporary relay and retained database; see the utilization-based refinement above.
- The user confirmed a maximum 30-minute write interruption overnight in America/New_York. Rehearsal must demonstrate that ceiling, including recovery or rollback; choose the exact night only after application observation gates pass.
- Observe each application move through a normal operating day; observe all application services together for at least 72 hours before the production database move.
- Retain the old database for 30 days after the database handoff. This is a proposed retention period, not a scheduled deletion.
- Request a temporary additional hosting budget of $100/month equivalent, prorated, for overlapping services, an isolated test/restore target, backups and a possible connectivity relay. Shared account fees and existing provider usage remain separately accounted for.

## Cost refinement from observed utilization

Seven days of hourly Render metrics (November 8–15) show average CPU use of approximately 0.0028, 0.0050, 0.0032 and 0.0021 cores for site, API, outbox and Discord. Maximum hourly memory samples were about 0.685, 0.909, 0.396 and 0.301 GiB respectively. These are hourly samples, not load-tested peak requirements; they do not justify assigning a 256 MiB instance to Discord or leaving the API with no headroom.

`scripts/migration/cost-model.mjs` models a conservative 6 GiB total memory allocation and 16 GB disk across four always-running Containers, four continuously active Durable Objects, a full $5 Workers allocation and the current $23.50 PostgreSQL cost. With available included usage and twice the observed CPU usage, moving services while retaining the $7 relay models $90.42/month versus $105.50 now: about $15.08/month saved. If shared allowances are consumed and CPU is five times the observed baseline, the model reaches $105.69/month, essentially no savings. Removing the relay at the same database price models $83.42/month, about $22.08 saved. Request/log/storage/egress overages, taxes and temporary restore overlap are excluded. The separate replacement quote is recorded below.

The idle-controller trial passed with the same Container surviving multiple Durable Object executions and an alarm. A conditional model with each controller active 5% of the time, included usage available and unchanged 6 GiB Container allocation estimates $77.92/month with the relay ($27.58 saved), or $70.92 without the relay at the same database price ($34.58 saved). The 5% duty cycle is an assumption; the separate replacement database has a live quote. Neither is measured production billing. The earlier $55–75 target requires this more efficient lifecycle/layout or validated smaller allocations; it is not the cost of the continuously monitored Container fallback. Avoid keeping all Durable Objects active with permanent monitor promises unless needed. Compare hibernation, bounded health alarms and a Worker-based website, and measure actual use before committing production resource sizes. Current Durable Object billing rounds excess duration to million GB-second units.

The encrypted R2 dump is 218,138,707 bytes; its downloaded SHA-256 and AES-GCM authentication both match. Encrypted metadata also passed a round trip. Its key is held outside R2, locally and in the GitHub Actions secret `STONEGATE_MIGRATION_BACKUP_KEY_20261115`. The manual `cloudflare-recovery-key.yml` workflow encrypts the escrowed key to an operator-supplied RSA public key (4096 bits or stronger). Its artifact contains ciphertext only and expires after one day. Run `43777328873` proved off-device recovery, matching the original key and authenticating the real encrypted metadata; the one-time private wrapping key was then removed. Retain access to both providers and this secret as long as the backup is retained. Do not overwrite this escrow when creating a different backup key.

An authenticated PlanetScale configuration quote on November 15 shows PostgreSQL 17.12, PS-10 ARM, one primary, 1 GB RAM, Virginia, and 15 GB storage at $11/month ($10 compute + $1 storage). It includes 30 GB backup storage and 100 GB egress, with overages shown at $0.023/GB backup storage and $0.06/GB egress. This retains single-node availability, as on the current Render database; it is not a high-availability plan. This exact configuration was provisioned for rehearsal on November 16 UTC. Direct Cloudflare connections and actual API reads pass; representative production load testing remains open. At that database price and with the relay removed, the model is $70.92/month for continuously active controllers or $58.42/month with the conditional idle-controller assumption: $34.58–$47.08/month saved. Consumed shared allowances and 5× observed CPU produce $86.19/month, $19.31 saved. All figures remain projections, excluding the overages and temporary overlap described above. The configuration defaults to PG18; explicitly select PG17 for parity. See [PlanetScale pricing](https://planetscale.com/pricing) and [Cloudflare's PlanetScale integration](https://developers.cloudflare.com/hyperdrive/planetscale/).

The phone-provider audit and browser API configuration identify an additional transition cost: preserving stale `stonegate-api.onrender.com` requests can require a small API forwarding service separate from the database Tunnel connector. If both remain at $7/month each, the services-first model is $97.42/month, saving $8.08 until one is retired. With the quoted $11 database and one legacy API forwarder retained, the continuous-controller model is $77.92/month ($27.58 saved), or the conditional idle-controller model is $65.42 ($40.08 saved). These are budget scenarios, not deployed resources or realized savings. The relay-free $34.58–$47.08 estimates apply only after both legacy dependencies have been retired. Existing browser code embeds the Render API hostname in lead/estimate forms and analytics; updating provider configuration alone does not retire that hostname.

## Baseline refreshed on November 15

| Resource | ID | Live source / configuration |
|---|---|---|
| Website | srv-d43o7c0dl3ps73a4rb2g | 5a90cf86608c76cd85773dbd2362b7fa07d5019c; Standard; one instance |
| API | srv-d43o7k0dl3ps73a4rhu0 | 0e66a789ea1c33b297aa5f1324571904c3fa2894; Standard; one instance |
| Outbox | srv-d43sdh0dl3ps73a8l70g | 0c0026b4cd0e26d65c93480e1aeb7e62596ffb0b; Standard; one instance |
| Discord | srv-d6fqpmvgi27c73cgd4jg | 5a90cf86608c76cd85773dbd2362b7fa07d5019c; Starter; one instance |
| PostgreSQL | dpg-d43o7c0dl3ps73a4rb4g-a | PostgreSQL 17; Basic 1 GB; 15 GB allocated; no HA; external IP allowlist empty |
| Render workspace | tea-cvl1h0odl3ps738ecuf0 | User previously confirmed; access still works |
| Cloudflare account | 78ed83c6e3947c93763acef3a48a5561 | OAuth refreshed; Workers/Containers permissions present |
| Website zone | 7eb7c6c85a93c7b0cae01de78028a40f | stonegatejunkremoval.com active in that Cloudflare account |
| R2 | stonegate; stonegate-appointment-media | Both still returned by the authenticated bucket inventory |

The initial read-only baseline found no Stonegate Workers or Hyperdrive. Execution subsequently created the diagnostic resources above. Authenticated browser tabs provide DNS UI access; the CLI OAuth token still lacks DNS/Access API scope. A dedicated migration SSH key now reaches the running Render API instance and provides private forwarding to both databases. External database allowlists remain empty. Backups and deployed settings were captured privately. The zone includes the Render apex address plus four legacy Squarespace apex addresses; these have not been altered.

Website and API auto-deploy after checks pass; outbox also uses checksPass; Discord auto-deploys on commits. Do not push migration changes to main while those triggers can deploy unreviewed combinations.

The current shell's Node 20 and root-owned npm cache initially prevented modern Wrangler startup. A task-specific temporary npm cache and Node 22 resolved that tool-only issue without changing the application's package files or global Node installation. Pin the deployment toolchain separately from application runtime choices.

## Phase 0 — Isolate the migration and establish access

Work:

1. Create an isolated migration worktree/branch after resolving the production-versus-unfinished-work decision. Preserve the existing worktree; do not stash, reset, clean or merge it automatically.
2. Record a per-service source manifest, build lockfile, image digest/deployment ID, feature flags and environment-variable names. Preserve the existing service version differences initially. Any baseline alignment must be a separately reviewed/tested release.
3. Establish Render SSH or an authorized internal shell for metadata-only database inventory and secure export. Prefer existing internal access; do not expose PostgreSQL to every Internet address.
4. Obtain the DNS capability needed for the verified zone and a secure way to transfer deployed secrets into target secret stores. Keep secret values and customer records out of Git, chat, CI logs and public artifacts.
5. Inventory actual DNS records, TLS, domains, provider callbacks, OAuth redirects, media origins, CORS, CSP, session cookies and service authentication. Inspect existing account-level Cloudflare plan usage and Render subscription eligibility.
6. Produce a reviewed costed resource list for the first staging phase. Preserve direct PostgreSQL connectivity for migration tools that use session advisory locks.

Exit evidence: reproducible per-service builds, confirmed account/zone ownership and capabilities, read-only database access, actual resource/endpoint/flag inventory, source decision, temporary budget and candidate maintenance window.

Status: isolated worktree, source manifest, SSH, environment inventory and browser DNS access established. Production behavior remains unchanged; final cost/availability and cutover timing gates remain open.

## Phase 1 — Prove recovery and the temporary network path

Work:

- Inventory actual application schemas, table/partition counts, sizes, extensions, sequences, functions, triggers, roles/grants, migration journal, large objects, foreign/materialized tables, and dependencies outside public schema.
- Inventory data families: customer/partner/team accounts; bookings; quotes; payment and expense ledgers; messages/calls; sessions/MFA; encrypted fields; integration cursors; audit logs; outbox rows, retry states and uncertain provider operations.
- Verify latest successful backup, PITR retention and restore capability. Make an encrypted export and restore it to an isolated disposable recovery target. Record elapsed dump/restore/validation time. Keep this recovery target distinct from the eventual production replacement.
- Build a repeatable, bounded-memory comparison tool: stable table/key ordering, canonical NULL/JSON/numeric/time handling, row counts and chunk hashes; print aggregate results rather than row contents.
- Inventory every referenced R2 object by key/size/checksum, check readability and document pre-existing missing references. Do not assume ETag is a content checksum. Preserve existing buckets. Resolve/protect pending staging uploads before their two-day expiry. Check actual phone upload and expense queues.
- Prove a secure route from each intended Cloudflare runtime to Render PostgreSQL, including TLS, connection limits, restart and outage recovery. The Render database is currently internal-only.
- For Worker-originated SQL, Hyperdrive with caching disabled for correctness-sensitive reads is a candidate. Private access requires a connector in the Render network. For Containers and administrative tools, validate the actual TCP/private-connectivity design separately: a Hyperdrive binding is not a general Internet PostgreSQL endpoint.
- Select the concrete temporary path only after testing account capabilities and pricing. Options include a private connector/relay or narrowly allowlisted stable egress with TLS. Do not assume normal Cloudflare Container egress has a fixed source IP. If no workable path fits the constraints, revise the design before moving the API.

Exit evidence: successful isolated restore, full application-data inventory, documented existing discrepancies, functioning secure Cloudflare-to-Render database connectivity, and measured recovery times.

Rollback: production remains on the original infrastructure. Temporary restore/relay resources can be removed once no longer needed.

## Phase 2 — Build and verify Cloudflare staging

Deliverables, to be implemented on the migration branch:

- Locked build/deploy toolchain and explicit staging/production configuration.
- Site deployment adapter selected by compatibility trial, with a Container fallback if the Workers path fails required behavior.
- Node Container images for API, outbox and Discord, preserving FFmpeg, Sharp, Argon2, PDF fonts and temporary-file behavior.
- Runtime secrets/settings manifest, readiness checks, metrics, bounded logs and cost alerts.
- Single-consumer lifecycle controls, restart supervision and graceful stop/drain behavior.
- Tested maintenance controls and durable inbound-event handling for the later database switch.
- CI jobs that build and exercise the actual Cloudflare runtime, with immutable release artifacts and reproducible rollback references.

Important implementation details:

- Use a disposable/sanitized test database and separate media test storage; production credentials and live business records must not be writable from ordinary previews.
- Keep public hostname/cookie behavior stable. Validate both Next.js configuration entrypoints, Contentlayer, server actions, proxy hops, cache headers, the 20 MB upload paths and Square CSP.
- Existing kill switches do not freeze all database writes: scheduler tasks, reconciliation and other paths still write. Build and prove a complete freeze covering API, webhooks, workers, scheduled jobs, imports and administrative scripts.
- Retain the PostgreSQL outbox. Do not simultaneously rewrite every background job into Queues/Workflows.
- Outbox and Discord must survive process death, cold starts and container lifecycle events. Specify one active dispatcher, stop claiming new work during shutdown and retain durable uncertainty markers.
- New-process ownership checks do not automatically fence the old Render code. The rollout must actually stop old consumers and prevent their auto-restart/auto-deploy before starting replacements.
- Prevent migrations from running automatically at every application start. Use a separate controlled migration job against the direct database endpoint.
- Do not assume a Worker deployment automatically finishes a Container rollout. Verify the running image and health of every intended instance.

Test matrix:

| Area | Required evidence |
|---|---|
| Identity | Existing password hashes, login/logout, session continuity, MFA, staff/partner permissions and tenant isolation |
| Website and UI | SSR, server actions, Team/Mobile/Partner navigation, booking, quotes, redirects, SEO and cache isolation |
| Financial | Sandbox payment initiation, retries, callbacks, reconciliation, invoices/refunds/expense arithmetic and idempotency |
| Media | Presigned uploads, CORS, image/HEIC/video/PDF processing, private downloads and mobile offline replay |
| Integrations | Signed Twilio/Meta/email/Square/Calendar callbacks; OAuth redirects; Ads, Traccar, OpenAI and Discord where enabled |
| Worker lifecycle | Restart mid-job, interrupted provider request, queue recovery, singleton ownership, heartbeat and schedule continuity |
| Database | Locking, transactions, pool limits, fresh reads, network interruption and restore behavior |
| Operations | Error/latency baseline, peak memory, cold start, logs without secrets/customer payloads, and projected costs |

Use existing CI suites for quotes, expenses, Partner Portal, providers and PostgreSQL as the baseline, pinned to the selected application revisions. Exercise PostgreSQL 17 for source parity and the actual chosen destination version. Tests named “production journey” in this repository use disposable infrastructure; they are not permission to run customer-facing actions against production.

Exit evidence: passing required tests, runtime compatibility, restart/failure drills, a proven freeze/replay procedure, rollback rehearsal and an updated cost forecast. No automatic promotion from staging.

## Phase 3 — Move application services, preserving Render PostgreSQL

Rollout order:

1. **Website.** Use an internal preview first. Verify authentication, cookies, server actions and media. Switch the existing public domain only after the candidate passes. Avoid mixing incompatible server-action builds across requests; retain old assets or implement version affinity where required. Monitor through a normal operating day.
2. **API.** Use a stable custom API hostname if the endpoint inventory confirms one is available. Validate signatures against exact allowed public URLs, including temporary legacy callback URLs; do not trust arbitrary forwarded headers. Update site/API settings and provider callbacks. Keep a forwarding path for stale Render callbacks until their retry windows are reconciled.
3. **Outbox.** Stop old dispatch, drain in-flight operations, confirm the old process is gone, and disable its automatic resurrection. Start exactly one Cloudflare consumer. Reconcile pending/uncertain effects, heartbeat and oldest runnable job age.
4. **Discord.** Stop the old bot, confirm disconnection, start the new one and test gateway reconnection plus scheduled tasks.

All application writes still go to the same Render database in this phase. Preserve existing encryption keys and feature flags. A narrow compatibility relay may temporarily remain on Render after the business services move; it is retired when no callbacks or database connections depend on it.

Phase gates:

- No missing or duplicate controlled business operations; no authentication or tenant-isolation regressions.
- No unexplained persistent increase in 5xx errors or material latency regression against the measured baseline.
- Healthy outbox heartbeat and stable/draining runnable backlog; future scheduled events are not incorrectly counted as overdue.
- Confirm actual running versions and only one active background consumer.
- At least 72 hours of stable combined application operation, including daily schedules. Exercise longer-period schedules safely in staging.

Rollback: route the affected service back to its retained Render version using the same database. Stop the new background consumer before reactivating the old one. Pause the next move until the cause is understood.

## Phase 4 — Create and synchronize the production database replacement

Begin after all application service gates pass.

1. Confirm the destination's PostgreSQL version, extensions, region, TLS/roles, connection limits, storage headroom, backups/PITR, recovery objectives and total cost. Confirm single-node versus HA matches the agreed availability requirement.
2. Provision an isolated candidate. Application production credentials cannot write to it during copying.
3. Prefer consistent initial copy plus logical replication when both providers support the full migration path. Render requires support enablement and Pro-or-higher workspace eligibility; verify target import/subscription capabilities rather than assuming them.
4. Freeze application schema changes for the migration. Copy schema and supported roles/grants deliberately. Standard logical replication does not transfer schema changes, sequence state or PostgreSQL large objects; inventory and handle them separately.
5. Measure lag and retained WAL on the Render source. Its storage autoscaling is disabled. Bound migration duration and alert before retained WAL can exhaust source disk.
6. If replication is unavailable, rehearse a final full export/restore under a write freeze. Only use this route if export, restore, complete verification, endpoint switch and recovery margin fit the user's downtime limit.
7. Verify every application-owned table, exact financial aggregates, object references, unique IDs, constraints and outbox state. Record any managed-provider metadata/role differences explicitly.
8. Run functional mutation tests on a disposable clone of the candidate. Do not pollute the actual synchronized production candidate with test writes.
9. Rehearse a backup and restore of the new provider as well as the source export.

Exit evidence: zero unexplained data discrepancies; compatible schema and keys; measured catch-up/final-validation duration; all needed non-replicated objects covered; backup recovery proven; forecast within the agreed budget.

## Phase 5 — Final database handoff

No cutover date is booked until Phase 4 timings fit the agreed window. Before the window, record the exact source/target IDs, roles, URLs, backups, hashes, deployed versions, ingress-buffer state, maintenance owner and abort deadline.

Sequence:

1. Check staff phone queues and unfinished uploads. Pause cleanup, publishing, financial dispatch and other scheduled effects as required.
2. Activate maintenance for interactive writes. Route inbound events to a durable journal outside the database being frozen. Validate signatures and persist the event before acknowledging it. Preserve original event identity, timestamp, ordering requirements and payload integrity for replay.
3. Handle synchronous voice and interactive callbacks separately. For example, voice webhooks require a valid timely response; merely queuing their bodies does not preserve calling behavior. Prove the voice continuity/fallback path and drain active operations where necessary.
4. Stop all database writers and dispatchers; drain active transactions and fence old application credentials/connections. Verify this at the database. UI maintenance and a default read-only connection setting alone are insufficient.
5. Finish replication or perform the rehearsed final restore. Establish and record the common verification boundary. Reconcile sequences, large objects and remaining non-replicated state.
6. Run final per-table counts/chunk hashes, financial and queue checks, schema checks and media-reference reconciliation against that boundary. Any unexplained mismatch prevents the switch.
7. Install the target credentials on every production component, recycle connection pools, and verify every service reaches the target database ID. Keep ordinary writes disabled during read-only smoke checks.
8. Declare the target authoritative. Replay buffered events under idempotency controls and the required ordering rules; then resume user writes and one background dispatcher per role. Record the first target-write time.
9. Reconcile received versus replayed event IDs, message/payment provider outcomes, job backlog and phone uploads. Keep source writers fenced.

Abort rules:

- **Before target writes:** if verification fails or the abort deadline is reached, restore service against the unchanged source and replay buffered events there.
- **After target writes:** never point application traffic at the stale source. Freeze target writes if necessary, preserve target and inbound journal, and use a tested reverse synchronization or forward repair. A retained old database is a recovery reference, not an automatically current rollback replica.

## Phase 6 — Observe, retire and validate savings

- Daily for the first week, reconcile critical business totals, webhook receipts, backlog, provider failures and backups. Review again at 14 and 30 days.
- Exercise all weekly/monthly scheduler families in staging before final retirement; verify the production schedules that occur during observation.
- Keep the old source read-only/protected, independent encrypted backups and compatible artifacts for the proposed 30-day retention period. Protect replication slots from unnecessary WAL retention after handoff.
- Verify there are no remaining requests, credentials, provider URLs, cron jobs, relay dependencies or CI deployment paths requiring the old Render resources.
- Demonstrate a restore of a recent target backup near the end of retention, and retain a final source archive under an explicit retention/access policy.
- Prepare a resource-specific retirement list and record the final retirement decision. No future automatic deletion has been scheduled.
- Remove obsolete services, temporary connectivity, access grants, migration credentials and old deployment triggers as each becomes unused. Keep unrelated Render applications untouched.
- Review measured billing after a complete target billing period and update the savings estimate. Increase/downsize resources only after peak-memory and job-load evidence supports it.

Completion evidence: reconciled data and event manifests, verified business workflows, recovery evidence, final runtime/secret/endpoint inventory, retired resources, updated operations documentation, and actual recurring cost.

## Deliverables and work order

| Work package | Deliverable | Depends on |
|---|---|---|
| A | Release manifest, isolated worktree and metadata inventory | Source decision; Render internal access |
| B | Backup/restore and bounded comparison tools; object inventory | A |
| C | Secure temporary database connectivity and credentials mapping | A; required account capabilities |
| D | Cloudflare staging builds, runtime configuration and CI | A; test infrastructure |
| E | Singleton lifecycle, maintenance and durable callback handling | C, D |
| F | Functional/load/restart/rollback evidence | B–E |
| G | Application migrations and 72-hour observation record | F |
| H | Target PostgreSQL, synchronization and measured rehearsal | G; provider eligibility and quote |
| I | Final comparison, controlled switch and event reconciliation | H; confirmed maintenance window |
| J | 30-day observation, recovery proof, retirement and billing review | I |

The first implementation package is A–D preparation: isolate source, establish database/DNS access, build the inventory/restore checks and run the website/container compatibility trial. Initial code and disposable tests can proceed while access is arranged. Production movement depends on the corresponding exit evidence.

Calendar dates and a reliable engineering estimate follow the access and runtime trials. The 72-hour application observation and proposed 30-day database retention are explicit elapsed-time periods, separate from implementation effort.

## Outstanding operating assumptions

The user authorized end-to-end execution and use of the open provider tabs. The confirmed Render workspace is My Workspace. Access and source-isolation choices have been resolved without changing the original working tree. No further permission is needed for authorized staging work.

The user confirmed up to 30 minutes overnight (Eastern time) for the final write interruption. The exact night, destination PostgreSQL plan and measured steady-state cost remain unsettled. Retain the proposed 30-day source retention; do not schedule a database handoff or deletion until recovery timings and all prerequisite gates support them.

## Technical references

- [Cloudflare Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- [Durable Object duration pricing and rounding](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Current Cloudflare Next.js deployment guidance](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Container rollouts and process lifecycle](https://developers.cloudflare.com/containers/configuration/rollouts/)
- [Container outbound networking](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
- [Private database connectivity for Hyperdrive](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/)
- [Cloudflare/PlanetScale PostgreSQL integration](https://developers.cloudflare.com/hyperdrive/planetscale/)
- [Render logical replication requirements](https://render.com/docs/postgresql-logical-replication)
- [PostgreSQL logical replication restrictions](https://www.postgresql.org/docs/current/logical-replication-restrictions.html)

The first draft-PR E2E run (`43787454593`) passed its quote and expense database jobs but its browser job exhausted Node 20's default roughly 2 GiB heap during the lint ratchet. Manual migration runs already used Node 24/PostgreSQL 17; non-manual workflow fallbacks now use that same target, and the lint step receives an explicit 6 GiB heap ceiling. This changes CI capacity and runtime selection, without weakening lint thresholds. The requested live delivery destinations (SMS, email, Discord) remain pending user input; no messages have been sent.

### HTTP transport and current CI follow-up

`infra/cloudflare/http-gateway` is a private, one-hour leased gateway trial, with no domain routes or public activation path. Its live fixture has no outbound network access or provider/database credentials. Readiness and activation are separate; activation checks the warmed instance generation. Drain stops admission, waits for requests and response streams, then sends SIGTERM. Ambiguous write responses return an error without replay or origin failover. Both 20 MiB upload hashes and two independent cookie headers survive the native transport. Three local streaming/auth/cancellation tests also pass. The gateway is stopped after validation. Production site/API entrypoints, legacy asset fallback on rollback and provider routing remain separate work.

PR run `43788197880` again passed all 109 browser checks, quote/expense database suites and partner units, but remains failed because the provider-source contract caught a hard-coded Twilio API origin in the new read-only inventory tool. That tool now uses the existing SDK resolver and runs under `tsx`; the contract is retained. Partner Portal follow-up found CommonJS named-import incompatibility and then a require base-path error in its browser harness; the helpers now resolve from the correct repository root. The later full E2E runs `43789893637`, `43790542276` and `43791701958` passed, including all 109 browser checks and quote/expense database suites. The final run uses `57cb75bb`, with remaining CommonJS helper imports corrected and a deterministic ciphertext-byte tampering test replacing a flaky Base64-character mutation. Partner Portal run `43791701972` is still completing its separate production browser journey.

### Durable webhook journal acceptance trial

`infra/cloudflare/webhook-journal` uses the official Twilio Node SDK (pinned 6.3.0) for form signature validation against the original external URL. It preserves the signed raw bytes and exact query string in Durable Object SQLite before acknowledging. Byte-identical retries share a row; distinct encoded payloads remain separate and require business/provider identity handling downstream. No source database access is needed to accept a callback. Replay is explicit, ordered and limited to pending rows; confirmed success marks delivery, while a lost response or non-success remains uncertain and blocks further replay. A recreated controller changes interrupted dispatches to uncertain. No event deletion or timer-based replay is implemented.

The private live trial passed 27 checks. Twenty simultaneous copies created one durable event; a 200 kB form survived storage and replay without truncation. A forced controller abort after a durable receiver commit preserved the event and prevented a second dispatch. Later events remained pending in all uncertain scenarios. Three local checks also pass, including Twilio's independently published signature vector, tampering and payload limits. This deployment uses a synthetic secret and only an in-account fixture receiver; it cannot send external provider requests. Original provider callback configuration remains unchanged (snapshot SHA-256 still `ea2e20dfc0dc68e0af9267fbd159af0737c078b71c981740d46d9873ae74b257`).

Before production use, bind the journal to reviewed real handlers and exact allowed callback URLs, prove business idempotency/reconciliation across retries, define appropriate ACKs separately for SMS/status and Studio call completion, and drain interactive manual/escalation calls. Interactive voice decision callbacks must not be deferred as if they were asynchronous notifications. See [Twilio webhook security](https://www.twilio.com/docs/usage/security) and [Cloudflare Durable Object SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
