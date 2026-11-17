---
section: For developers / Tests
---
- The CLI's one-shot test about one group (`oneShotOneChat.test.ts`) makes its seven groups and twelve unused invites all at once, and the daemon that makes them has no relay budget (the one-shots it measures keep theirs). The file runs in about 29 s instead of 174 s on CI.
