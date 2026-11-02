---
section: Fixed / CLI
---
- `ghostly listen` started while the profile's daemon is still starting (a service manager that starts the daemon and its listener together) now waits for it and follows it. Before, it failed `busy` at once, while a listen started a second later followed the daemon past restarts.
