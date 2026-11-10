---
section: Fixed / Chat
---
- With many chats, the chat list no longer slows the app down each time something changes, such as a new message, a typing indicator, or a file's progress. Each chat in the list used to search every other chat several times on each change. That work grew with the square of the number of chats: about 60 ms per change at 2,000 chats. It now grows in step with the number of chats.
