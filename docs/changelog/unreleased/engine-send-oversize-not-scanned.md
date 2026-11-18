---
section: Fixed / CLI
---
- A raw engine send (`ghostly engine sendMessage`, `editMessage`, `sendGroupMessage`, `sendGroupFile`, or `engine.call` over the socket) with a text past 16 KiB now gets the engine's size refusal at once. The secret guard read the whole text first: a 15 MB text held the daemon for 2 to 5 seconds, every chat with it, before the same refusal, and a 15 MB run of one letter ended in "Maximum call stack size exceeded". A text the engine refuses by its size is not read for a secret, since none of it can go; every text within the bound is still read.
