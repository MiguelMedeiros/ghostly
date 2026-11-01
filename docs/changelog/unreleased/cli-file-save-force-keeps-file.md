---
section: Fixed / CLI
---
- `ghostly file save --force` now replaces the file only once the received one is written whole. Before, a save that failed (the file's bytes not on this device, a full disk) deleted the file it was asked to replace, leaving neither the old one nor the new one.
