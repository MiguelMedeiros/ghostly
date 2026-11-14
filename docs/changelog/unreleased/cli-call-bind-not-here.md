---
section: Fixed
---
- CLI calls: with `GHOSTLY_CALL_BIND` set to an address this machine doesn't have (a typo, or a network that changed since the daemon started), starting a call crashed the whole daemon, along with every chat it was running. Now the call is refused and says why, and when you answer a call, your contact's app shows that it couldn't connect.
