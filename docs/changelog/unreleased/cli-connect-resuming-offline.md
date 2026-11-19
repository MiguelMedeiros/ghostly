---
section: Fixed / CLI
---
- `chat connect` that times out in a daemon's first 5 minutes no longer says the chat is still resuming after the start when the chat was already live in this run (held by the contact since, say), or when the contact's record reads offline. It now says the contact did not answer, or that the contact's app reads online.
