---
section: Fixed / CLI
---
- A `ghostly profile backup` that fails while it writes the profile's store (a full disk, for one) no longer leaves that partial copy of the store in the profile's folder. Each failed try left one more, taking the room the next try needed.
