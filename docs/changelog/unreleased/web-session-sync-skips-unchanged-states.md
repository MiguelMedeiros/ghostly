---
section: Fixed / Chat
---
- On the web and in the browser extension, an update from the app's engine that changes nothing about your chats (a file moving, a link checking in) no longer makes the page read every chat back from its storage: with 300 chats, each such update cost the page about half a millisecond, up to 20 times a second while a file moved.
