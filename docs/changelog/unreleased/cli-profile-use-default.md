---
section: Fixed / CLI
---
- `ghostly profile use default` now makes the `default` profile when it does not exist yet, as every other command on it does. Before, in a Ghostly folder whose first command was `profile create <name> --use`, it was refused with "No profile default" (exit 3).
