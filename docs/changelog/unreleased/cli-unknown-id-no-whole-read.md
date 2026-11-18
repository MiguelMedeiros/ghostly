---
section: Fixed / CLI
---
- `ghostly edit` and `ghostly react` naming a message id the chat does not have (a typo, a message deleted since) no longer read the chat's whole history at every call, and `edit` no longer reads it twice. In a chat of 100,000 messages each such call held the daemon for about half a second to a second, and its other commands waited. The chat is now read once per daemon run, for the few messages that go by another id than their own, and later calls answer in about a millisecond. `ghostly group edit` with an id the group lacks no longer reads the group's whole history to say so. The answers, error codes and exit statuses are unchanged.
