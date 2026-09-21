# Staff schedule capacity warning release

The owner confirmed the affected jobs are regular CRM appointments and requested deployment. Staff can now save overlapping appointments without an override reason or separate conflict-override permission. Calendar, Inbox, and Mobile retain successful saves and display the capacity warning. The warning is included in the mutation audit. Public and automated booking capacity checks, configured closures, external blocks, and partner resource rules remain enforced.

Release source: [`6cf9ef75703b76050fcf603fbc34399e3b6cd588`](https://github.com/TailoredAgents/StonegateOS/commit/6cf9ef75703b76050fcf603fbc34399e3b6cd588). The release was isolated from unrelated local edits and applied on current `main`, preserving the prior framework security and partner CRM updates. No schema, dependency, or service configuration changes are included.

## Validation

- API and Site typechecks passed on the isolated release.
- All 99 focused API tests passed, including staff warnings and strict public/service/automated behavior.
- Eight browser/action tests passed, covering Chromium and WebKit at desktop and phone sizes, saved warnings, resource retries, partner confirmation refresh, and 44 existing mobile action checks.
- Targeted lint had no errors, and diff whitespace checks passed.
- The exact-source [production journey run](https://github.com/TailoredAgents/StonegateOS/actions/runs/35655651644) passed its regression, browser, PostgreSQL, production build, and complete browser journey stages before rollout.

## Deployment

The tested revision was pushed to `main` with automatic deployment suppressed, then explicitly deployed to Site followed by API so the warning display was available before the scheduling rule changed.

| Service | Deployment | Live at (UTC) |
| --- | --- | --- |
| Site | `dep-daoq2bu0tbcc73ee5kc0` | 2026-09-21 21:31:24 |
| API | `dep-daoq4hugekts73ek93c0` | 2026-09-21 21:36:44 |

Both services were verified live on the exact release revision. At 21:37:29 UTC, both `/api/healthz` endpoints returned HTTP 200 with `ok`, the team login loaded successfully, and unauthenticated Calendar and Mobile requests retained their respective login redirects. The postdeployment application error-log queries returned zero entries for both services. Verification did not create production appointments or send customer messages; authenticated scheduling behavior was exercised in the controlled production-build tests.

Local evidence is retained in `artifacts/schedule-capacity-release-20260921/`.

Rollback source is `c50de74bf324e7d7d7f6e41926b8d5625331e195`; previous deployments are Site `dep-dao8ad3m8hqs73dm6pm0` and API `dep-dao896ugekts73b98osg`.
