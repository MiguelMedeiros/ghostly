---
section: Fixed / Calls
---
- A call from or to a Linux Desktop could go out with no network address at all, and never connect: on a slow DNS lookup of the STUN server, its own addresses waited behind it. The STUN server is now looked up first, with its own time limit, and a call waits for at least one address before it goes out.
