---
section: Fixed / CLI
---
- `ghostly message delete <chat|group> <message> --purge` on a message no longer here (the contact deleted it for everyone, or a delete without `--purge` came first) or on another member's group message still answers not found, but now folds the store all the same and says so (`details.purged: true` in the error), so what a deleted copy said leaves the profile's folder too.
