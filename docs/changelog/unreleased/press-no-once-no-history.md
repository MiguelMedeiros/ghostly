---
section: Fixed / Chat
---
- A press on a bot's buttons with no `once` button among them no longer reads the chat's whole history: it costs what a plain reply does, however long the chat (a full read is about 100 ms at 10,000 messages on the CLI daemon). Pressing a contact's buttons already worked this way.
