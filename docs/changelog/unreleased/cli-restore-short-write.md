---
section: Fixed / CLI
---
- `ghostly profile restore` no longer reports a profile as restored with its last file cut short when the disk fills as that file is written: it writes the rest, or fails with `unavailable` ("No room left on the disk") and leaves no profile.
