---
section: Fixed / CLI
---
- A daemon writes less to the disk for each message. Each saved change went into the message database in a write of its own, so a message's send, delivery steps and read rewrote the same pages one after another: about 150 KB written for each message, and every 50 or so messages a pause of up to 150 ms on the daemon's only thread while the database caught up. The changes saved within a quarter of a second now go in together: about 110 KB for each message of a conversation, and those pauses come about half as often. Each change is still on the disk before the daemon says it is done, as before.
