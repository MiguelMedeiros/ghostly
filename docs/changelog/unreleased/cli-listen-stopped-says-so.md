---
section: Fixed / CLI
---
- A `ghostly listen` that found no daemon and ran the profile itself, stopped by `ghostly daemon stop` or `daemon restart` (the advice after an upgrade), now exits 1 with a line on stderr saying what ended it and how to avoid it, and `daemon stop`/`restart` say that what they stopped was a listen (`listen: true`). Before, it ended with exit 0 and no word, so a service manager did not start it again and a bot's hooks silently stopped.
