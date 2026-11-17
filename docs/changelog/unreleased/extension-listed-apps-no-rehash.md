---
section: Fixed / Extension
---
- An extension tab no longer hashes again, at every message, mark, presence change and file progress step, the chat key of each chat and group member that lists an app, only to skip the apps it had already noted. With 300 chats and 500 group members listing apps that was about 4.5 ms of each update per open tab; now a chat's key is hashed only when it lists an app the tab has not noted yet.
