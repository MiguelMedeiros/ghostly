---
section: Fixed / CLI
---
- `ghostly invite create` without a daemon answers in under a second again in a profile with many chats. It started every saved chat as well, and from about ten their publishes took the relays' requests for the minute: the new invite waited 20 s behind them and was often not published by the time the command left. It now starts the new invite only, and asks the relays 12 times instead of 60.
