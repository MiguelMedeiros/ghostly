---
section: Fixed / CLI
---
- `ghostly file save` into a folder it may not write, or onto a full disk, now names that folder (or the file asked for) in its error and in `details.path`. It named the hidden `.ghostly-save-…partial` file the save writes first, a random name that never exists.
