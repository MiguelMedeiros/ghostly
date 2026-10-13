---
section: Fixed / CLI
---
- `payment check`, `payment reclaim`, `identity share`, `identity recheck`, `lightning default` and `lightning rename` with an id that names nothing now say `not_found` (exit 3) and the list to look in, as the other commands do, instead of the engine's error (`engine`, exit 1).
