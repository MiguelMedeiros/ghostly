---
section: Fixed / CLI
---
- A daemon no longer reads a chat's or group's whole history to name the message of its first file event after a start. A contact's file, or a file whose message was older than the newest 100 messages, made the daemon read every message of that chat once per run: about 1 s and 70 MB at 100,000 messages. It now reads only the messages that carry a file.
