---
section: Fixed / Chat
---
- A long chat list starts and idles with less work: each row's mute menu worked out the end time of every duration on every redraw, even while it was closed (about 1 s of a start with 70 chats and groups, and about 0.5 s of every idle 20 s). It now does that only when the menu opens.
