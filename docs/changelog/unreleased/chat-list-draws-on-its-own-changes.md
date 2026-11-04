---
section: Fixed / Everywhere
---
- The chat list no longer draws again on every change elsewhere in the app. Each change, up to 20 a second while a file moves, made the whole list and every row in it draw again, about 10 ms each with 30 chats. Now it draws only when something it shows changes. In a test with 30 chats, 20 changes elsewhere caused no draws; before, each one drew the list.
