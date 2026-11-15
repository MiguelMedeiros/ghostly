---
section: For developers / Tests
---
- `node tools/scripts/test-bloat.mjs` writes the weekly test-bloat report from the CI artifacts already uploaded: the slowest test files and each package's growth over the week, the slow tests that never failed in the kept reports, the mock-only tests, unit and e2e tests on the same feature with matching names, the e2e tests that passed only on retry, and the nightly scores. A section with no artifact behind it says which artifact would carry it. `--json` prints the data and `--summary` the five lines the weekly routine posts.
