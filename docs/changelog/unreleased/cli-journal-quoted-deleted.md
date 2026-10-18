---
section: Fixed / CLI
---
- A message deleted on this device, or deleted for everyone by its author, no longer stays in the CLI's event journal inside the replies that quoted it: `listen --since`, `events` and an agent turn's `untrusted.replyTo` replay those replies with `found: false, deleted: true` and an empty `snippet`, as history says.
