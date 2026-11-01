---
section: Fixed / CLI
---
- `profile set --share-profile --no-share-profile` is a usage error ("--share-profile or --no-share-profile, not both", exit 2) and changes nothing, as the CLI's other either-or flags are. Before, the last one won: sharing went off (or on) with exit 0.
