---
section: Fixed / CLI
---
- `ghostly profile backup` through a running daemon no longer stops it while the backup copies the store: with 100,000 messages the daemon answered no call and heard no contact for over a second; it now goes on within a tenth of a second.
