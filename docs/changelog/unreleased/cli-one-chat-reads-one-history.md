---
section: Fixed / CLI
---
- A one-shot command about one chat without a daemon, such as `ghostly chat history <chat>` or `ghostly chat send <chat>`, reads only that chat's history when it starts. It read the whole history of every 1:1 chat in the profile first, which added about 0.45 s and 80 MB for every 50,000 messages, even for a chat with 20 messages.
