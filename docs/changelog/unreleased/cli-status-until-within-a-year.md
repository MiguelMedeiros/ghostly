---
section: Fixed / CLI
---
- On the daemon's socket, `status.set` now refuses an `until` more than a year from now (`bad_request`), as `status set --until` does. It took any whole number, up to one past the last time a date can hold, and the app's status picker then read "until Invalid Date".
