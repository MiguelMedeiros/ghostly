---
section: Fixed / CLI
---
- One-shot `ghostly saved list` without a daemon reads no 1:1 chat's history when it starts. It read the whole history of every 1:1 chat first, though it reads each saved message by itself: with 30,000 messages in the profile it took about 0.5 s longer, even with nothing saved.
