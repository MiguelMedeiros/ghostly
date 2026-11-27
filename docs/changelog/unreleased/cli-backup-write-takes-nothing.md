---
section: Fixed / CLI
---
- `ghostly profile backup` onto a disk that takes no byte of a write (full) fails with `unavailable` ("No room left for" the backup), as restore and the copy under its name do, not with the bare error "The backup's file took no more bytes".
