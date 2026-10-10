---
section: Fixed / Chat
---
- Sending a text no longer gets slower as a chat grows: a send and its receipt read the message itself, not the whole history. On the CLI, a send in a chat of 1,300 messages took about 650 ms of CPU.
