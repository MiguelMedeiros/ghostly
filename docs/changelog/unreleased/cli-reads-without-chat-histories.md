---
section: Fixed / CLI
---
- One-shot `ghostly status`, `status show`, `chat list`, `profile show` and `settings get` without a daemon read no chat's history when they start. They read the whole history of every 1:1 chat first: with 50,000 messages in the profile each took about 0.3 to 0.6 s longer and 50 MB more memory.
