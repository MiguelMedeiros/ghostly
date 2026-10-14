---
section: Fixed / CLI
---
- A call placed in the same millisecond as the hang-up before it now rings at the contact, and a hang-up sent in its offer's millisecond ends the contact's ring: each call signal the CLI sends in a chat is dated at least 1 ms after the one before it, so the contact no longer drops it as not newer. A bot that redialed at once lost about 1 call in 20 (it rang 60 s, ended unanswered and was busy for that minute).
