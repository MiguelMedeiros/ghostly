---
section: Fixed / CLI
---
- `listen --from <contact key>` now passes the removal of that contact's chat. Before, it matched a chat to the key by asking the daemon, and a chat that is gone has nothing to ask about, so its `chat.removed` was dropped unless the same run had already seen the chat. A `--since` or `--cursor` replay always dropped it, since the journal keeps nothing else of a removed chat. A `chat.removed` event now carries `peer`, the contact's key, once the chat is paired.
