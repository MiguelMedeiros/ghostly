---
section: Fixed / CLI
---
- An agent turn from a 1:1 chat names the contact: `untrusted.name` is the name they gave, as the docs show, instead of always null. A contact's `message.received` event and `chat history` carry it as `message.nick` too.
