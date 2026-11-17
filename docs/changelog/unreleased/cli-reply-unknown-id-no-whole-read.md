---
section: Fixed / CLI
---
- `ghostly send --reply` naming a message id the chat does not have (a typo, a message deleted since) no longer reads the chat's whole history at every call. In a chat of 100,000 messages each such send held the daemon for about a second, and its other commands waited. The chat is now read once per daemon run, as `edit` and `react` already do, and later calls answer in a few milliseconds. The answer, error code and exit status are unchanged.
