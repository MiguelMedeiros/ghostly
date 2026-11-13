---
section: Fixed / Chat
---
- A chat on DHT only left open no longer redraws the app at every read of the contact's mailbox when nothing changed. With many DHT-only chats this was up to about 46 times a minute, each one going over every chat, so a profile left open spent CPU for nothing on screen.
