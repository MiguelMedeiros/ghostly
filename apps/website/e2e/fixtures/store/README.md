# The site's test store

A store index signed by a test key, and the bundles its listings point at, for the `/apps` pages' checks
(`e2e/apps-pages.spec.ts`) and for `packages/browser/test/websiteStore.test.ts`, which builds it from fixed test seeds
and fails when these files differ. Nothing in it is real, and its keys are not the official store's.

`GHOSTLY_STORE_FIXTURE=1 npm run sync:references` makes the site read it instead of the official store
(`scripts/sync-store.mjs`). `fixture.json` names the key the index is signed by, the clock the pages read it at, and the
file each bundle URL serves.

Write it again after a format change:

```bash
cd packages/browser && WEBSITE_STORE_FIXTURE_WRITE=1 npx vitest run test/websiteStore.test.ts
```
