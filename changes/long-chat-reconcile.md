---
section: For users / Chat
---
- A long chat no longer slows the web app and Desktop down while it is open: keeping the chat list in step (on every update, and every 5 seconds) reads a chat again only when it changed, so a new message, an edit or a reaction in a chat of 2000 messages costs the page about 5 ms instead of 20, and an update with nothing new costs almost nothing.
