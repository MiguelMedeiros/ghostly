---
section: Fixed / Chat
---
- A bot that edits its messages faster than they can go (or while the contact is away) no longer drives its CLI daemon to full CPU with pauses of many seconds: each look at the edits still on their way, and each confirmation of one, read every such message on its own, all at once, instead of reading them together or reading the one confirmed.
