---
section: Fixed / CLI
---
- `ghostly task send --item queued:Publishing` is refused with the item states it takes (pending, running, done, failed, skipped), instead of making an item that reads "queued:Publishing". Text without a state, like `Step 2: build`, is still a pending item.
- A task marked done, failed or cancelled no longer says "Now: …" in the text older apps show.
