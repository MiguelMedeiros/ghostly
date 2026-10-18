---
section: For developers
---
- A page can attach to the engine with only each chat's newest page (`EngineServer.attach(client, read, { newest })`), and ask for one chat's whole history when it needs it (a `{ kind: "history", linkId }` message, which the host hands to `EngineServer.history`: that chat's `messages` event comes back, in order with its changes). A `messages` event that holds only the newest page says so with `more: true`. Nothing attaches this way yet: the extension's pages will, so that opening a tab no longer sends every chat's whole history across (about 15 MB for 50 chats of 2,000 messages, against 0.4 MB for their newest 50).
