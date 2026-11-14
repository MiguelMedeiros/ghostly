---
section: Fixed / CLI
---
- Over the socket API, `chat.accept` with a method and no `on` now turns that method on in the chat, as `ghostly chat accept <chat> <method>` does; only `on: false` turns it off. Before, a missing `on` turned the method off (with or without `networks`), so a script that left it out silently stopped taking that way of paying. An `on` that is not a boolean is still refused.
