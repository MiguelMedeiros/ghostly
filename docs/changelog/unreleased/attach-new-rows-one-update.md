---
section: Fixed / Chat
---
- The web app at a start, and the browser extension when a tab opens after its background page started again, no longer redraw the chat list once for every chat with new messages: the chats' new messages are told once for all of them. With 2,000 chats that each had a new message, this took about 17 s before.
