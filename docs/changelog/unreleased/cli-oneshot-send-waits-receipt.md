---
section: Fixed / CLI
---
- A script that sends with one-shot `ghostly send` (no daemon) to a contact who is online no longer gets a 30 s timeout every few messages. Its last text no longer shows "Connection closed before receipt" when the contact has it. A text sent over the live connection now waits up to 2 s for its receipt before the command leaves. A one-shot that does time out says the text goes with the profile's next command, or with `ghostly daemon --detach`.
