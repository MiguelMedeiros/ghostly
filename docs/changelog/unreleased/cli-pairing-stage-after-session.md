---
section: Fixed / CLI
release: 1.14
---
- `chat show` and `chat list` no longer say `"stage": "live"` beside `"live": false` once the session a chat's first pairing opened has ended: `stage`, and `progress` in `chat show`, read null then, as they do after a restart. While that session is up they still say `live`, and a pairing under way shows each stage as before. The `chat.pairing` events are unchanged.
