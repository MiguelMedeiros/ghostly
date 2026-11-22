---
section: For developers / Tests
---
- `npm run test:map` on a pull request fails on a test file it adds that declares nothing (no `@feature` tag, `// covers:` or the new `// guards: #<issue>` line for a test that guards a bug), and on a user feature it adds to `e2e/features.json` with no ungated e2e test and no reason on `e2e/allow-untested.json`. Test files already there still only warn. `npm run test:map -- --base=origin/dev` runs the same check before you push.
