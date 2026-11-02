---
section: Fixed / Chat
---
- A long chat costs less each time it connects again: the app no longer reads the whole chat to look for status cards that need to go again, unless one does. In a 10,000-message chat on the CLI, a reconnect took about 190 ms less CPU on each side.
