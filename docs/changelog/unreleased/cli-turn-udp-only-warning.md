---
section: Fixed / CLI
---
- `settings set iceServers` with a `turns:` or `?transport=tcp` TURN server warns on stderr that the CLI does not use it: the CLI reaches TURN over UDP only. The apps still use those servers. Before, the CLI skipped them without a word.
