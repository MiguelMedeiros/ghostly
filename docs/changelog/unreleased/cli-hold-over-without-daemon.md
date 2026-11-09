---
section: Fixed / CLI
---
- Without a daemon, once a `chat disconnect --hold` is over, `chat show`, `chat list` and `status` no longer say on stderr that the hold "could not end: Delivery method unavailable.", and `chat show` gives `heldUntil: null`. The chat leaves DHT only the next time a command opens it, such as a `send`.
