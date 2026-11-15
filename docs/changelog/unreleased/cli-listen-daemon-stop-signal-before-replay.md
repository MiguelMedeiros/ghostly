---
section: Fixed / CLI
---
- A `ghostly listen --exec` that follows a running daemon and is stopped just as it starts no longer leaves its hook running. The events it replays from the cursor could start a hook before the listen took Ctrl-C, SIGTERM and SIGHUP as a stop, so a stop in that moment ended it at once, the hook ran on, and the next listen ran that event's hook again beside it. Now the hook is ended and its event is handed again at the next start, as for a stop at any other time.
