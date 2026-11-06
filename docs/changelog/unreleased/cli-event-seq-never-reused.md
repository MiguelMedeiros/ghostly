---
section: Fixed / CLI
---
- After the disk filled up, a restarted daemon no longer numbers new events with seqs it had already told listeners but could not write to its event journal. A bot resuming with `listen --cursor` (or `--since`) skipped those new events, which could be a contact's message, with nothing saying so. The daemon now reserves event numbers ahead in a small file it rewrites in place, so a start always numbers past every event it told, and a replay across the ones that were lost says `events.gap`. After a crash the numbers can skip ahead too, also with an `events.gap`.
