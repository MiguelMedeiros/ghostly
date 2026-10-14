---
section: Fixed / Desktop
---
- On Linux, a notification server that stops answering no longer holds back every later message's sound and notification: the app does not wait for a notification before the next event, nor more than 5 seconds for a server that does not answer. When the server comes back, a chat still has one notification, replaced by its next message and closed when the chat is read.
