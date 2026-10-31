---
section: Fixed / CLI
---
- `ghostly identity add` with `--days` or `--timeout` out of range is a usage error that names the flag, before the profile opens (`--days takes a whole number from 1 to 365, not 0`); it answered after opening it, in the API's words, and `--days 1.5` reached the engine's own check.
