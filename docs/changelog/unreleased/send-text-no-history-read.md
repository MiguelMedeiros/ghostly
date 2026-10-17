---
section: Fixed / Chat
---
- Sending a text in a long chat no longer reads the chat's whole history first. Each send read and sorted every message to find older ones still waiting to go, and usually found none: about a fifth of a second per text at 10,000 messages on the command line, so a bot that posts often in a long chat lost that time on every message. Now the chat's history is read only when something older may still be waiting.
