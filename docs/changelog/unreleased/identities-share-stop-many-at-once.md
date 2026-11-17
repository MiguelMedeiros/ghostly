---
section: Fixed / Identities
---
- Stopping sharing many identities at once in a chat (Share only this, or several `identity withdraw` in a row) now reaches the contact for every one of them: some used to stay Verified on the contact's side until the next reconnect. Your app now spaces out what it sends a contact so it fits that contact's per-chat limits, keeps at most 8 shares waiting for an answer at a time, and sends a share or a stop that got no answer again after a minute, then after longer waits. A reconnect with more than 8 shares waiting now completes all of them in the same connection.
