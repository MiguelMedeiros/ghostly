---
section: Fixed / CLI
---
- `ghostly file save --wait` of a file sent from this profile saves it at once. Before, it waited for the contact to take the file, up to its timeout, and failed with exit 1 when they declined, though the file's bytes were already here (without `--wait` it saved).
