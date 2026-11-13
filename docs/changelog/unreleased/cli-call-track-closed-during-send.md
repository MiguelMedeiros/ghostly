---
section: Fixed / CLI
---
- CLI calls: a call whose connection drops while a frame of audio goes out no longer logs an uncaught "Track is not open" error from the daemon. That frame is dropped, as one sent on a closed track already was.
