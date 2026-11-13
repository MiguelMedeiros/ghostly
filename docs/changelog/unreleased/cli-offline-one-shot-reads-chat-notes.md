---
section: Fixed / CLI
---
- Commands that change something on this device with no daemon running (a message deleted for this device only, and the like) no longer read the event stream's note of every message active in the last 30 days when the change touches a chat's history. They read only that chat's notes, as `send` and the other commands do.
