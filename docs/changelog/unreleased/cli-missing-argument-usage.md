---
section: For developers / CLI
---
- `ghostly group create`, `group rename` and `lightning rename` without a name, `profile picture` and `group picture` without a JPEG or `--clear`, and `forward` without a message or `--to` answer `usage` (exit 2) with what is missing ("Missing <name>: ghostly group create <name...> [--mesh]"), before the profile opens, as the other commands do; before, they opened the profile and answered `bad_request` (exit 1) with "name is required" or "path is required".
