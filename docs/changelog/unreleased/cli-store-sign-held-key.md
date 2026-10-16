---
section: Fixed / CLI
---
- `store sign` with a `--key` file that is not there no longer makes a new store key over a folder that holds an index signed by another key: it answers `not_found` naming that key, and a key that is there but is not that one is `refused` (`store-key`), as `app publish` does. Another store is another `--out`.
