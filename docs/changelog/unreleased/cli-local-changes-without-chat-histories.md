---
section: Fixed / CLI
---
- One-shot `ghostly status set` and `status clear`, `x401 key new`, `x401 credential add` and `remove`, `service add`, `identity cancel`, `app serve` and `unserve`, and `call answer` and `call flush` (which a one-shot refuses) without a daemon read no 1:1 chat's history when they start. They read the whole history of every 1:1 chat first, though none keeps anything in a chat: with 30,000 messages in the profile each took about 0.95 s and 200 MB instead of 0.5 s and 140 MB.
