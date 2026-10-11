---
section: For developers / CLI
---
- `task update`, `routine update` and `usage send` no longer read the whole history of the chat or group to find their card. The daemon remembers which message carries each card it sent or found, and reads that one message; only the first update of a card after a start still looks through the history. In a chat of 10,000 messages an update took about 120 ms of the daemon's time (a usage report twice that) and now takes under 1 ms, whatever the chat's length.
