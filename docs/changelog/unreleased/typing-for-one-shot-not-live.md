---
section: Fixed / CLI
---
- `ghostly typing <chat> --for N` (and `group typing --for N`) without a daemon no longer holds the terminal and the profile for N seconds when the chat is not live: it waits up to 15 seconds for the chat to come up, then stops and answers `live: false`. Once the chat is live it stays the whole time, as before.
