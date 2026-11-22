---
section: For developers / Tests
---
- CI's "Frontend tests (app)" runs `npm run test:app` in three shards balanced by time (`node tools/scripts/test-shards.mjs --app <shard> 3`), the UI's tests cut by their files, instead of on one runner in 9-13 minutes. Its shards upload their Vitest reports as `app-test-reports-<shard>`, and `--record` over several runs' reports keeps each file's median time; `tools/scripts/test-durations.json` is recorded again from five green runs, so the packages shards even out too.
