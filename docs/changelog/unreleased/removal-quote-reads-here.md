---
section: Fixed / Chat
---
- A contact or a group member who deletes for everyone many messages in a row, ones that are here too, no longer makes the app read the whole chat for each one: their quotes are looked for at most once every 10 seconds per chat, the first at once. Before, each removal read the chat whole (234 ms in a group of 10,000 messages), up to three times a second per member.
