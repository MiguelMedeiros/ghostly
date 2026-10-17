---
section: Fixed / Everywhere
---
- CLI: a bot serving a mini-app no longer loses the other chats' events from its event journal. Each frame the contact's app sent was written there, and at the app's allowed rate the journal was full in about 20 seconds, so `listen --since` or `--cursor` after a short stop answered `events.gap` instead of the texts other contacts sent. `app.opened`, `app.message` and `app.closed` now go to live listeners only and are never replayed.
