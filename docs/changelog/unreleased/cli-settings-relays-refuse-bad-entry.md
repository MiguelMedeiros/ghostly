---
section: Fixed / CLI
---
- `settings set relays` with a working relay next to one it can't read is refused, naming that one, as `irohRelays` and the app's Settings do. Before, the bad one was dropped without a word (exit 0). `settings set irohRelays` with more than five relays is a wrong value (`bad_request`, exit 1) instead of an engine failure, and a relay given twice counts once.
