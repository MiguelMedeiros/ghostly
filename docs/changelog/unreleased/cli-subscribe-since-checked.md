---
section: Fixed / CLI
---
- On the daemon's socket, `events.subscribe` now refuses a `since` that is not a whole number from 0 (`bad_request`), as `events.replay` does, and subscribes nothing. A cursor sent as text (`"since":"412"`) started the stream at the newest event with no error, skipping every event after 412, and a negative one reported a gap of events that never existed. `events.replay` now refuses a fractional `since` too. Left out or `null`, `since` still means from now.
