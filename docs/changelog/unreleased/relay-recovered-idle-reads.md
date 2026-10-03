---
section: Fixed / Everywhere
---
- An app with many chats whose contacts are away does less network work while idle. When a Pkarr relay answered again after a rate limit or an outage, every chat looked for its contact at once, even the ones that had missed nothing: on a profile with 42 chats that was 42 lookups each time a busy relay came back. Now only the chats that missed a lookup, or that are looking for their contact right now, look at once; the others keep their pace.
