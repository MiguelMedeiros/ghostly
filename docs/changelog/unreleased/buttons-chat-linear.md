---
section: Fixed / Chat
---
- A long chat with a bot that asks with buttons no longer stalls the page each time a message arrives. Each question's buttons are now checked against only its own answers, not against the whole history. In a 5,000-message chat with a question every 5 messages, each new message cost about 90 ms of work before (over 300 ms on a slow phone).
