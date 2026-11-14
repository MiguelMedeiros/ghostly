---
section: Fixed / CLI
---
- One-shot `ghostly identity providers`, and `call auto` and `group auto` with no `on` or `off`, without a daemon read no 1:1 chat's history when they start. They read the whole history of every 1:1 chat first, though they only say what the CLI knows or the profile keeps: with 50,000 messages in the profile each took about 0.8 s longer and 60 MB more memory.
