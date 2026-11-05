---
section: Fixed / Chat
---
- In the web app, a push relay address that answers "not found" by itself (a mistyped address, a proxy with no route for it) no longer makes the app forget how to wake your contacts and linked devices. Only the push service's own answer, passed on by the relay, can say a wake-up target is gone.
