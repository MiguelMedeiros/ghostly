---
section: Fixed / CLI
---
- `ghostly call hangup`, `answer`, `get`, `flush` and `pipe` given the id of a call that already ended (a second hang-up, or a script racing the call's end) now say `No call <id>: it ended or never existed`, not that no chat has that name. The error code and exit status are unchanged.
