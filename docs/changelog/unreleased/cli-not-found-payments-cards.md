---
section: Fixed / CLI
---
- `payment check`, `payment reclaim`, `identity share`, `identity recheck`, `lightning default` and `lightning rename` answer an id that names nothing as `not_found` (exit 3) with the list to look in, as the other commands do. Before, each was an engine error (exit 1).
