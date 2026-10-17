---
section: Fixed / Everywhere
---
- CLI: `ghostly listen | head -n 1` (or any reader that leaves) now stops quietly with exit 0 at the next event. Through a daemon it crashed with an `EPIPE` stack trace. Without a daemon it never exited, and the profile stayed in use until `ghostly daemon stop`.
