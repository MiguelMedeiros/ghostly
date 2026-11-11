---
section: Fixed / CLI
---
- `ghostly button update --chosen <id>` with an id the message's buttons don't have now answers `not_found` and exits with 3, like `button press` does for the same mistake. It answered `bad_request` and exited with 1, so a script that checks exit codes treated the same mistake two ways.
