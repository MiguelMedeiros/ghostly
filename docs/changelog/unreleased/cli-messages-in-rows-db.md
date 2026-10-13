---
section: Fixed / CLI
---
- A profile's messages are kept on disk (`rows.db` beside the store) instead of in the daemon's memory: about 650 bytes a message instead of 1,300, and a profile opens in half the time (50,000 messages: 31 MB and 0.16 s instead of 62 MB and 0.31 s). The first start after the upgrade moves them once (about a second at 50,000). Needs Node 22.13 or newer; on Node 22.12 nothing changes. Once moved, the profile no longer opens with an older ghostly; a backup (`profile backup`) restores with any release.
