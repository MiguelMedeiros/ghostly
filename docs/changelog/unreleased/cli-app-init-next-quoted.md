---
section: Fixed / CLI
---
- `ghostly app init` quotes the folder in its `next` line when it holds a space, a quote or a `$`, so the line pasted into a shell publishes that folder. Before, `app init "My App"` answered `ghostly app publish My App --key …`, which a shell reads as the folder `My` and an extra word.
