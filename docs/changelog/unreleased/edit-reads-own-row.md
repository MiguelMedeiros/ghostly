---
section: Fixed / Chat
---
- Editing a message no longer gets slower as a chat grows: an edit and its confirmation read the edited message, not the chat's whole history. A bot that updates a card in place read the history three times for every update, and once more 20 seconds later. On the CLI, ten edits in a chat of 5,000 messages took 3.7 s and now take 1.9 s.
