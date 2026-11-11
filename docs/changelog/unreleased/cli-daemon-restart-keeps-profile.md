---
section: Fixed / CLI
---
- `ghostly daemon restart` no longer leaves the profile without a daemon while other commands run. Between the stop and the start, a bot's one-shot commands (a typing indicator every few seconds, a send) could each take the profile in turn, so the new daemon never got it and the restart failed busy. The profile is now kept for the daemon `daemon restart` (or `daemon --detach`) starts: other commands wait for its socket and then go through it. A command that reached the old daemon as it stopped, before it was sent, is now sent to the new one instead of failing with "The daemon went away".
