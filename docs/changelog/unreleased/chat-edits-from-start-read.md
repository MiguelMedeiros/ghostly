---
section: Fixed / Chat
---
- Opening the app no longer reads each chat's whole history a second time when its first connection opens, only to look for edits still on their way. Those come from the history read once at start, so a profile with long chats starts with half the reads, and an edit or a delete for everyone made before a restart still goes when the chat connects.
