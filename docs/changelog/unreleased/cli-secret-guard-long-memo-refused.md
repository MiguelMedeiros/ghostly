---
section: Fixed / CLI
---
- A payment's memo, a Lightning address comment, a name, a status or any other text the secret guard reads (`chat pay`, `chat request`, `pay`, or `ghostly engine` and `engine.call` over the socket) is refused with its size when it is past 16 KiB, before the guard reads it. The guard read it whole first: a 5 MB memo held the daemon for 3 seconds, every chat with it. No text Ghostly sends is that long (a memo goes as its first 140 characters); with `--force` it goes as before.
