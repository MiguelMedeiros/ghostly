---
section: Fixed / CLI
---
- CLI calls: a call that could not connect (it did not connect within 30 s, or its connections kept failing) now tells the contact so when it hangs up, as the apps do and as a failed answer already did. The contact's app said "ended" for a call that never connected, and a CLI contact reported `remote-hangup`; both sides now say the call couldn't connect (`failed`).
