---
section: Fixed / CLI
---
- `ghostly file wait` (and `file save --wait`) that times out now says where the transfer stands in words, such as "waiting for a connection to the contact", "paused by the contact" or "waiting for the contact to take it", instead of the stage's id ("waiting", "paused", "asking"). The id stays in `details.stage` for scripts.
