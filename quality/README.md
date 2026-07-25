# Quality ratchet

`lint-baseline.json` records the pre-existing ESLint errors by application,
file, and rule. `pnpm lint:ratchet` rejects every increase while allowing the
legacy count to fall gradually.

New and touched files are still expected to pass ESLint and TypeScript with
zero errors. Refresh the baseline only when intentionally accepting a changed
repository-wide debt snapshot:

```sh
pnpm lint:ratchet:update
```
