---
section: Fixed / Everywhere
---
- CLI: a command whose change stays on this device (`chat rename`, `chat remove`, `call auto on|off`, `identity cancel`, `service add`, and `settings set` for sendTyping, autoDownloads and serveFiles) now works offline when no daemon runs. It answers at once, sends nothing to the relays, and your contacts no longer see this device come online for it. Before, each one put the profile on the relays and waited for them: 3.3 s with a slow relay.
