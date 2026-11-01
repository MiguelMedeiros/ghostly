---
section: Fixed / CLI
---
- `call start` and `call answer` run without a daemon now say a call needs one (`ghostly daemon --detach`). Before, a one-shot `call start` said "Calls need a live connection", which no one-shot could get in time.
