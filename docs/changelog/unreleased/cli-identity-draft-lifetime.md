---
section: Fixed / CLI
---
- `identity add` now says a proof waiting for `identity complete` is kept 30 minutes, and while fewer than four newer ones wait, as the daemon keeps it. Before, it promised an hour, and a draft the daemon had already dropped failed at `identity complete` with "This proof was started too long ago".
