---
section: Fixed / Groups
---
- In groups, a member's connection being read again (each member republishes it every 4 minutes), a connection attempt, a drop or a hub saying whom it reaches now builds only that group again for the app, not every chat and every group: about 19 ms of work saved each time with 2,000 chats (1.7 ms with 200), which with 20 groups of 16 added up to more than once a second while the app sat idle. A hub's word heard again within a second builds nothing.
