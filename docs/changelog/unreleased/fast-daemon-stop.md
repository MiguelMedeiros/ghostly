---
section: Fixed / Chat
---
- `ghostly daemon stop` (and quitting the app) no longer publishes anything after saying goodbye to your contacts, besides the packet that says the app left. Before, a chat could start a new connection offer and publish it a few seconds after the goodbye, while the app was still stopping. The stop is also quicker: it waits for its wallets, held messages and chats side by side instead of one after another.
