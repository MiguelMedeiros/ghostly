---
section: Fixed / CLI
---
- A `--timeout` on `edit`, `remove`, `react`, `pin` and group sends with `--wait`, and on `daemon --detach`, `daemon stop` and `daemon restart`, now ends on time when the computer's clock is set back while it waits. It ran as much longer as the clock went back, so the client gave up first and said the daemon did not answer and should be restarted; a clock set forward ended it early.
