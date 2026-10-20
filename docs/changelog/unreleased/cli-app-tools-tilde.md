---
section: Fixed / CLI
---
- `ghostly app init`, `app publish`, `app verify`, `app revoke` and `store sign` now treat a path starting with `~/` as your home folder, as the rest of the CLI already did. Before, `app publish --key=~/pub.key` wrote your one publisher key into a folder literally named `~` in the current folder.
