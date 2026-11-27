---
section: Fixed / Chat
---
- Two Block contact or Unblock requests made at the same time (by a script or the CLI) now both take effect. Before, when one of them had to replace the push subscription, only one was kept: the other contact went back to unblocked after being told to stop waking the app, or stayed blocked after an Unblock.
