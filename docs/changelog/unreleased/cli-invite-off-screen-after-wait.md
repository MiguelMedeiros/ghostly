---
section: Fixed / CLI
---
- A daemon no longer keeps an invite nobody joined as the chat on screen for good: once its 10-minute wait for a peer is over, it is read at the background pace like the daemon's other invites. Before, that last invite was read about 11 times a minute forever and held the other invites' reads back, so a join on an earlier invite of a daemon with many unused ones was noticed only after 3 to 7 minutes.
