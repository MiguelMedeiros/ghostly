---
section: Fixed / CLI
---
- A one-shot `edit --wait confirmed` or `group edit --wait sent` that times out now says the edit goes with this profile's next command, or to keep it online with `ghostly daemon --detach`, as `send` does. Before, it said it would go "while this profile is online", as the one-shot was closing it.
