---
section: Fixed / CLI
---
- `ghostly group call <group> --sfu "" --e2ee` (or `--no-e2ee`), as a script sends it with an unset variable, is refused with `sfu is required`, as an empty `--sfu` is on its own, instead of signing the group's old call node again.
