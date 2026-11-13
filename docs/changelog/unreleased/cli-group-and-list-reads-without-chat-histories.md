---
section: Fixed / CLI
---
- One-shot `ghostly group list`, `group show`, `group history`, `call list`, `service list`, `identity list`, `app served` and `x401 credential list` without a daemon read no 1:1 chat's history when they start. They read the whole history of every 1:1 chat first: with 50,000 messages in the profile each took about 0.3 to 0.5 s longer and 67 MB more memory.
