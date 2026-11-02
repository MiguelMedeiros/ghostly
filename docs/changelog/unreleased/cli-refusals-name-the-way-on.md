---
section: Fixed / CLI
---
- A CLI refusal says what to type next: `chat remove`, `group leave` and `group forget` ask for `--yes (yes: true over the socket)` and `file save` for `--force`, the flag first (it read "pass yes (--yes)"), and a chat or group not found points to `ghostly chat list` or `ghostly group list`, as `file list` already did.
