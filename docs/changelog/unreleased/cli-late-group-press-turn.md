---
section: Fixed / CLI
---
- `ghostly listen --turns` now gives an agent turn for a member's press on a button of your group question when the press arrives after the reply itself (the reply first came through another member without it). Before, an agent that asked the group never saw that member's answer. The late `button.pressed` event now carries the reply as `message`.
