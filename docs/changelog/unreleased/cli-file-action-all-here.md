---
section: Fixed / CLI
---
- `ghostly file cancel|decline|pause|resume|accept` on a chat's file that is already all here is refused (exit 1) with "Nothing to stop: the file is all here" or "Nothing to ask for: the file is all here", as for a group's file, instead of answering exit 0 with the action as if it had done something.
