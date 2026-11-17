---
section: Fixed / CLI
---
- One-shot `ghostly wallet address`, `wallet remove`, `lightning rename` and `lightning default` no longer start every saved chat and read its history first: with 10 chats and 30,000 messages each took about 0.35 s more and 20 relay requests, even to say there was no such wallet or card. `lightning rename` and `lightning default` now open the profile offline, as other changes kept on this device do.
