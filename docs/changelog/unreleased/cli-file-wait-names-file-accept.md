---
section: Fixed / CLI
---
- `ghostly file wait` and `ghostly file save --wait` on a received file that waits for you to take it (over 25 MiB, or a group's file that did not come by itself) now answer at once (exit 5) with its name, its size and the command that takes it: `ghostly file accept <file>` (or `file decline`). Before, they waited their whole timeout (300 s by default) for a file that could not start, then answered "0 of 40000000 bytes, asking", as if the contact were slow.
