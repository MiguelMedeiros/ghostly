---
section: For developers / CLI
---
- `ghostly button update` without `--chosen`, `--close` or `--text`, `chat verify` without `--code`, and `typing` or `group typing` with a `--for` outside 1 to 600 are usage errors (exit 2) that name the flag. They answered in the words of the API's parameters ("code is required", "for must be a number from 1 to 600") with exit 1.
