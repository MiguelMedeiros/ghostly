---
section: Fixed / CLI
---
- `file send --wait sent`, `file wait`, `file save --wait`, `chat wait` and `invite create` waiting through the daemon when it stops or restarts now answer at once as `send --wait` does: `timeout` with `details.reason: "daemon-stopped"`, a file send with its `messageId` and file id (the file is kept and goes by itself), an invite with its link. Before, they waited until the daemon ended the connection and got only "The daemon stopped before it answered file.send, which may be done", so a bot could not tell which file it had sent and sent it again.
