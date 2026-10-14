---
section: Fixed / Chat
---
- A chat with many files and voice messages no longer slows the app down when it connects: each file that had already finished read the chat's whole history again on the chat's first connection after every start, and its details then said it was completed at that moment. On the CLI, a chat of 5,000 messages and 300 files took 41 s of reading there and now takes 0.2 s. A file's details keep the time it really finished.
- Sending or receiving a file or a voice message no longer gets slower as a chat grows: it reads the message that carries the file, not the chat's whole history (twice for each file sent, once for each received).
