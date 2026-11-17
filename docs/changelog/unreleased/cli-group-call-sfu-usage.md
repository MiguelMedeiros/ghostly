---
section: Fixed / CLI
release: 1.14
---
- `ghostly group call <group> --sfu <value>` with a value that is no https origin, or one past 200 characters, is now a usage error (exit 2) before the profile opens. Before, it was refused only once the profile was open and the group found (exit 1), and a group that was not there was said first (exit 3).
