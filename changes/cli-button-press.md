---
section: For developers / Bots
---
- `ghostly button press <chat> <message> <button>` presses a button of someone else's question from the CLI, as a tap in the app does. A test bot or a person in a terminal no longer needs `engine pressButton`.
- `button.pressed` now carries `untrusted.name`, the name the person gave themselves. `name` stays the chat's name here (the label you gave it), and the README and SKILL.md now say so; before, they called `name` the contact's own name.
