---
section: Fixed / CLI
---
- A one-shot about one chat (`chat send`, `invite create`, `invite join` and the other chat commands) with no daemon running no longer reads every group's whole history first, only each group's newest message, as the read-only commands already do: about 0.4 s and 80 MB less per 50,000 group messages.
