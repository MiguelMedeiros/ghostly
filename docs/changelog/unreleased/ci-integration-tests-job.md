---
section: For developers / Tests
---
- The package tests that start real peers, daemons or a DHT (`tools/scripts/integration-tests.json`, 30 files and about 40% of the packages' test time) run in one Integration tests job, on batches, a ready pull request at its base's tip and nightly, not in the four package shards or the draft tier. Each shard drops from about 870 to about 480 seconds of test time. `npm run test:affected` names the integration tests a change reaches, and runs them with `--integration`. A plain `npm test` still runs them all.
