---
section: For developers / CLI
---
- `ghostly profile use|list|show|set|backup|restore`, `daemon` (and `daemon status|stop|restart`), `settings get` and `engine --list` refuse words past their usage with `Too many arguments` (exit 2), as every other command does; before, they dropped them, so `ghostly profile use my bot` selected the profile `my`.
