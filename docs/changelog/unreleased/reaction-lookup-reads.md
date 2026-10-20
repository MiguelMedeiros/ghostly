---
section: Fixed / Chat
---
- A contact's reactions to messages the chat cannot find by their id (a file's or a payment's, or ids that never were) no longer make the app read the whole chat for each one: such a chat is read at most once every 10 seconds, the first at once, and the reactions that came meanwhile land then. Before, 20 of them read a chat of 10,000 messages whole 20 times.
