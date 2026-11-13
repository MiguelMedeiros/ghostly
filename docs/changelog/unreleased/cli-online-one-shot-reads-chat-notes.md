---
section: Fixed / CLI
---
- Commands that talk to contacts with no daemon running (`message send`, `react`, `edit`, `group send`, `file send` and the like) start faster on a busy profile. Each one read the event stream's note of every message active in the last 30 days first: 50,000 of them added about 0.07 s and 56 MB to every such command. They now read only the notes of the chats whose history changes while they run.
