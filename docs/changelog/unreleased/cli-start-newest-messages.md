---
section: For developers / CLI
---
- A daemon, and a command run without one, no longer read the whole history of every chat and group at each start to know which events are new: after a clean stop they read each one's 100 newest messages, and the whole history only where something is new, after a crash, or once the engine changed it. With 100,000 stored messages that was about a second of every start and 50 MB of its peak memory.
