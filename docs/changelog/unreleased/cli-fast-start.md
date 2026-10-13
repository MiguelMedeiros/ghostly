---
section: For developers / CLI
---
- A command a running daemon answers starts in about 40 ms instead of about 130 ms: the CLI loads the engine only when it runs the profile itself, and Node keeps its compiled code between commands. An `--exec` hook that calls `ghostly send` per event pays that once per event.
