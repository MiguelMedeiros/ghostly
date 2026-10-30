---
section: Fixed / CLI
---
- Without a daemon, `ghostly send`, `chat wait`, `file send` and the other commands about one chat start only that chat, and `invite join` starts only the chat it joins. Before, they started every saved chat as well, and in a profile with a dozen chats those took all of the relays' requests for the minute: an `invite join` could stay unpaired for its whole minute, and a text to a contact who was away, or the next command, waited behind them.
