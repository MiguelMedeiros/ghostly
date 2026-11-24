---
section: Fixed / Chat
---
- On the web, the chat list no longer reads every saved key again for each chat whose first sync is under way, on every change of the app's state, while the app starts: the chats' keys are read once per change, and not at all once no chat is mid-sync. With 300 chats each of those changes took up to 169 ms in Chromium when every chat was mid-sync (about 0.56 ms per chat mid-sync); now about 0.6 ms in all.
