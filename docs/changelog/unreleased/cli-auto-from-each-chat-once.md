---
section: Fixed / CLI
---
- `call auto on --from` and `group auto on --from` (and `call.auto`, `group.auto` on the socket) read each chat once and keep it once, and refuse more than 256 before reading any: one chat given 50,000 times held the daemon about 8 s, and `call auto` kept all 50,000 in `calls.json`, read again on every incoming call.
