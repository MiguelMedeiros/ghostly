---
section: Fixed / CLI
---
- A time given in seconds (`$(date +%s)`) to `routine send --next`, `usage send --resets` or `chat history` and `group history --before`/`--after` was read as milliseconds: cards said January 1970 and history answered an empty page or every message. It is now a usage error that gives the time in milliseconds. A short number after `--before` or `--after` is a time too (`--after 0` is the whole history), not a message id that answered "No message 0".
