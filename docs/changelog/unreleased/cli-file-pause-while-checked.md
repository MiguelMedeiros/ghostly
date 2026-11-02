---
section: Fixed / CLI
---
- `ghostly file pause` on a file that is being checked (every byte is there and its contents are being verified) is now refused with "Too late to pause: it is being checked" and exit 1. Before, it answered as if the file were paused, with exit 0, and the file then finished anyway.
