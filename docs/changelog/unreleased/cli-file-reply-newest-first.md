---
section: Fixed / CLI
---
- `file send --reply` looks for the message it answers among the chat's (or group's) newest 200 first, and reads the whole history only when it is older. In a chat of 20,000 messages each such send took about a quarter of a second longer.
