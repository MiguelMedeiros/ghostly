---
section: For users / Calls
release: 1.11
---
- With Hide my IP from contacts on, calls work in the Linux app too: its own call engine asks no STUN server, uses
  your TURN server only and sends relay candidates only, so a contact sees the server's address and never yours.
  With no TURN server it can use, or one that does not answer, the call ends with "Your relay did not answer"; it
  never connects directly.
