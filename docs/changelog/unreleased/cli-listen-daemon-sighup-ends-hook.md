---
section: Fixed / CLI
---
- A `ghostly listen --exec` that follows a running daemon now ends its hook when the terminal or SSH session it ran in closes. It stopped only on Ctrl-C and SIGTERM, so a closed terminal ended it at once and left a running hook behind, and the next listen ran that event's hook again beside the old one. It now stops as on Ctrl-C: the hook is ended and its event is handed again at the next start, as a listen that runs the profile itself already did.
