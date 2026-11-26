---
section: Fixed / CLI
---
- `ghostly app publish --out <dir>/` and `--key <dir>/`, and `ghostly listen --cursor <dir>/`, refuse a folder that is not there ("No such folder"), as `file save --path` does. Before, the slash was dropped and the bundle, the new publisher key or the cursor was written as a file named after the folder, and the next `app publish` packed that stray bundle into the app.
