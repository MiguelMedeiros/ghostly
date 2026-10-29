---
section: Fixed / CLI
---
- `settings set readRelays false` answered exit 0 and changed nothing: the CLI reads the Pkarr relays first whatever it says. It is now refused (`bad_request`) with the reason, and `settings set`'s help no longer lists it.
