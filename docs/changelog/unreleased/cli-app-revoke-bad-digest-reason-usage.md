---
section: Fixed / CLI
---
- `ghostly app revoke` refuses a `--digest` that is not a bundle digest, the same `--digest` twice, more than 64 of them, and a `--reason` that is empty, blank, more than one line or longer than 200 characters as a usage error (exit 2) that names the option and the value, as the other `app` commands do. Before, it refused them only once the statement was built (`refused`, exit 1, without naming the option), and it signed and published an empty `--reason`.
