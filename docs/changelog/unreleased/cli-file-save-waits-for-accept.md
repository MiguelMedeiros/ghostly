---
section: Fixed / CLI
---
- `ghostly file save` of a received file that waits for you to take it (over the automatic download's size, or a group's file that did not come by itself) answers exit 5 naming `ghostly file accept`, as `file save --wait` and `file wait` do. Before, it answered "The file is not all here yet (0 of N bytes)" with exit 1, and a script retried it for good.
