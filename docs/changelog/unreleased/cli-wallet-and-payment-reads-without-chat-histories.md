---
section: Fixed / CLI
---
- One-shot `ghostly wallet list`, `wallet history` and `payment list` without a daemon read no 1:1 chat's history when they start. They read the whole history of every 1:1 chat first, though the wallet and its payments are kept apart from it: with 50,000 messages in the profile each took about 0.5 to 1 s longer and 90 MB more memory.
