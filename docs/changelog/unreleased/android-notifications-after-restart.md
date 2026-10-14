---
section: Fixed / Android
release: 1.3
---
- Message notifications left from before the Android app was closed (swiped from Recents, ended by Android in the background, or updated) work as before it closed: tapping one opens its chat, the chat's next message replaces it, and reading the chat takes it away. Before, a chat could then show two notifications, reading it left the old one behind, and tapping the old one opened no chat.
