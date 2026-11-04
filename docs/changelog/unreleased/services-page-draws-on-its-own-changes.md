---
section: Fixed / Everywhere
---
- The Services page costs less while it is open: it no longer draws again on every change of the app's state (up to 20 a second while a file moves), and it reads its contacts' names without reading every chat's messages each time. With 300 chats, 20 such changes took about 850 ms of drawing in a test, now none.
