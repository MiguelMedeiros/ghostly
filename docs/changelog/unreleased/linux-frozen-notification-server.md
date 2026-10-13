---
section: Fixed / Desktop
---
- On Linux, a notification server that stops answering no longer holds back every later message's sound and notification: the app does not wait for a notification before the next event, and gives up on a server that has not answered in 5 seconds.
