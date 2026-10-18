---
section: For developers
---
- CI's four packages test shards take about the same time again. The shard that ran @ghostly/browser took a median 503 s against 150 to 262 s for the others, and set the length of every full CI run: a package was never cut, and browser had grown to over a third of all the packages' test time (one file, groupFilesBack.test.ts, takes 253 s), while the recorded test times were from 2026-10-01. A package heavier than one shard's fair share is now cut by its files across the shards, and the times are recorded again from CI's reports of 2026-10-18: the three shards beside twoPeers plan 707 s of test time each, where they planned 1,048, 649 and 428 s.
