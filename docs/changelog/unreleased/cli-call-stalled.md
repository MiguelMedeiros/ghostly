---
section: For developers / CLI
---
- A headless call no longer stays "connected" in silence for about half a minute when the contact's side dies mid-call (a crash, a closed laptop, a lost network): after 5 s without any audio from the contact a bot gets `call.stalled` (and `call.resumed` if it comes back), and the call ends as `failed` after 15 s.
