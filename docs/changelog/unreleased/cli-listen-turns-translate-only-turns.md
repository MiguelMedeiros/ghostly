---
section: Fixed / CLI
---
- `ghostly listen --turns --translate` translates only the messages that become turns. A contact's edits and a group's messages that did not name the bot each went through the translation model first and were then dropped, and the next real turn waited behind all of them.
