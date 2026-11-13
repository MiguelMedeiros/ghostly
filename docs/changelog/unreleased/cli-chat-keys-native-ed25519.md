---
section: Fixed / CLI
---
- A command run without a daemon starts faster on a profile with many chats, and so does `ghostly daemon`. Each start works out two keys for every chat, and these now use Node's own Ed25519 code instead of the slower JavaScript code. With 200 chats, `ghostly status`, `chat list` and `profile show` take about 60 to 110 ms less each (about 20%).
