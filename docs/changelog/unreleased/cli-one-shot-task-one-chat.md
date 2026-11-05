---
section: Fixed / CLI
---
- CLI: a one-shot `task send`, `task update`, `routine send`, `button press`/`update`, `usage send` or `message delete --everyone` to a 1:1 chat starts only that chat, as `send` does, and leaves the other saved chats unstarted (the groups still start, since the name may be a group's). With 12 saved chats one task card took 34 requests on the relays, more than their 30 a minute, so the bot's next one-shot or a text to an away contact waited; now 11.
