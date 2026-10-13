---
section: Fixed / CLI
---
- A command that only reads (`ghostly status`, `chat list`, `chat show`, `chat history`, `settings get`, `group list`, `wallet list`, `events` and the like) answers from the profile in a fraction of a second with no daemon running, and says nothing to the network. It used to start every chat, publish to the Pkarr relays and wait for them: 3 seconds with a slow relay, 10 with one that did not answer.
