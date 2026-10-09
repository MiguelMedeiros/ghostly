---
section: Fixed / Chat
---
- A `ghostly` daemon with long histories answers its first command right after it starts, and `ghostly daemon stop` is done, in a fraction of a second. Before, the daemon read every chat's whole history again after it had read them at start, and once more at stop, which could take about 2 seconds each with 50 chats of 1000 messages.
