---
section: Fixed / Chat
---
- A chat that reconnects, or moves to another transport, no longer reads its whole history three times when nothing
  waits to go again: in a chat with 10,000 messages that cost the CLI daemon over half a second of work per
  reconnect. Texts written while the contact was away, texts awaiting their receipt and edits still go when the chat
  is back.
