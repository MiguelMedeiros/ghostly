---
section: Fixed / CLI
---
- `ghostly engine forwardMessages` reads each message once, and none when more than 30 are named, before the engine forwards them or refuses: one id given 50,000 times was read 50,000 times at once, holding the daemon for the engine's refusal or its one message, as `chat forward` did before.
