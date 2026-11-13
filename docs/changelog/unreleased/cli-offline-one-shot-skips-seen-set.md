---
section: Fixed / CLI
---
- Commands that only read the profile or change this device (`ghostly status`, `chat list`, `settings get`, `chat rename` and the like), run with no daemon, start faster on a busy profile. Each one read the event stream's note of every message active in the last 30 days first: 50,000 of them added about 0.16 s and 56 MB to every such command. They now read those notes only when a chat's history changes while they run.
