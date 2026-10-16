---
section: Fixed / CLI
---
- A one-shot `ghostly invite join` (no daemon) says whether the chat paired: its answer carries `"paired"` and the `stage`, and when the inviter was away for its 60 s wait, stderr gives the next step ("Not paired yet: … keep this profile running (ghostly daemon --detach), then ghostly chat wait <chat> --until paired"). It answered only `{"chat":…}`, paired or not. The help and CLI.md say a one-shot waits up to 60 s.
