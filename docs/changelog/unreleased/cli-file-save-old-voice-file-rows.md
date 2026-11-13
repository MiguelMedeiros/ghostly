---
section: Fixed / CLI
---
- `ghostly file save` of a voice message older than its chat's newest 200 messages no longer reads the chat's whole history to name the saved file. In a chat of 100,000 messages each such save took about a second, and a daemon answered nothing else for 0.8 s of it. It now reads only the messages that carry a file.
