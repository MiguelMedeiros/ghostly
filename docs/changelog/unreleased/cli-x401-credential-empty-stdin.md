---
section: Fixed / CLI
---
- `x401 credential add -` with nothing on stdin is a usage error (exit 2) naming stdin and a file, as `invite join -`, `group join -` and `wallet redeem -` answer theirs. Before, it was a bad request (exit 1).
