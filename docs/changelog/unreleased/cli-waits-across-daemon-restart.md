---
section: Fixed / CLI
---
- `chat wait` and `file wait` going through a daemon that restarts now wait on with the new daemon, for the time they had left, and `file send --wait` answers as `send --wait` does: `timeout` (exit 4) with its `messageId`, the file's id and how far it got, and `details.reason: "daemon-stopped"`. Before, all three failed with exit 4 "may be done: check `ghostly chat history` for a message", with no id for the file, and a bot that sent the file again sent it twice.
