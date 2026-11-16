# November 16 public-site and campaign release

Released 2026-11-16T18:03:41.187475+00:00 from application commit `749ebb50ab02faf34d56ad744b15af50604ba57a` through the existing Cloudflare website and Render API/outbox setup. The public-site refresh, compact mobile cookie notice and campaign workspace are live. The 40% sale and campaign sending are off; this release sent no campaign messages.

## Live services

| Service | Live release | Rollback |
|---|---|---|
| Cloudflare website | `stonegate-site-release-20261116`; digest `sha256:b17ca57137135465aff7d7a120f70489780b4b399cf1044e2a2d44bd14b77241` | Existing `stonegate-site-production` Worker remains running |
| Render API | `dep-dbtk6n0u01pc73e5ulug` at `749ebb50` | `dep-db8k5gnavr4c73ftkn2g` |
| Render outbox | `dep-dbtk9k142hec738timg0` at `749ebb50` | `dep-db5ukie7bikc73e4ch8g` |
| PostgreSQL | Existing Render database; additive migration `0184_sms_campaigns` applied and verified | Keep the new tables and all records |

The original Render website remains available with auto-deploy off. Discord remains suspended. API and outbox auto-deploy are now off too: their configured `main` branch still has the older application. Reenable automatic deployment only after the intended branch contains the tested release and the service handoff plan is updated. No provider, customer-message, DNS or database-hosting cutover was performed for this release.

## Verification

- [Full E2E checks](https://github.com/TailoredAgents/StonegateOS/actions/runs/43919433211) and [Partner Portal production journey](https://github.com/TailoredAgents/StonegateOS/actions/runs/43919433581) passed on the deployed application revision.
- All 202 prior server action IDs and the existing encryption key match. All 124 existing immutable files were retained; 34 additional files were uploaded and hash-verified, for 158 preserved assets.
- The private build used the exact existing Cloudflare image as its runtime base, removed the old application directory and rebuilt clean committed source. Native image checks passed for Node 24.22.1, image processing, password hashing, FFmpeg, Cloudflared and PDF generation. No compatibility patch was applied twice.
- Thirteen pages passed browser checks at both 390px and 1440px widths on the candidate and again on the public domain. No browser errors or horizontal overflow were observed. The mobile cookie notice is 122px high and dismissal persists after reload.
- API readiness passed. The configured API/outbox environments were verified unchanged, campaign controls remained off, the public promotion is null, and the campaign API requires authentication.
- The existing static-file Worker and scheduled health monitor now bind to the release Worker. The temporary asset uploader was removed after the upload; the R2 files remain available to both versions.

## Rollback and continued migration

Switch the two broad HTTPS website routes back to `stonegate-site-production`; keep both `/_next/static/*` routes on `stonegate-site-rollback-validation`. The previous Worker and Render website were retained. Do not delete either build's immutable assets. If rolling back the Render services, use their recorded previous deployments and leave campaign tables intact.

The machine-readable [production release manifest](../../infra/cloudflare/releases/2026-11-16-site-campaigns.json) records the live artifacts. `source-manifest.json` and the earlier migration receipts describe the November 15 baseline. Their older API/outbox revisions and compatibility-patch application lists must be refreshed before the remaining Cloudflare migration; they are not proof for moving this new application revision. The integrated source already includes the retry lock and graceful-drain changes.

Private credentials, compatibility keys and raw deployment evidence are outside the repository in the Windows operator directory `~/.local/share/stonegate-release-20261116`. The original migration evidence directory is unchanged. No credentials or customer records are committed.

## Campaign launch

The workspace is at `/team/marketing/campaigns`. Actual booking and service cutoff dates, sender readiness, consent evidence and the owner-test/batch-release steps still follow the [winter-sale runbook](../runbooks/winter-sale-campaign.md). Publishing the workspace does not activate pricing or authorize sending a test or customer batch.
