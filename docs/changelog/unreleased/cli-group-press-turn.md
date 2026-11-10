---
section: Fixed / CLI
---
- `ghostly listen --turns` wakes the agent when a group member taps a button of a question it asked in that group, as
  a mention does, and the turn's `press` says who tapped (`by`). Before, a press in a group started no turn and was
  dropped, so an agent waiting for a tap on "Deploy to staging?" never heard it. A tap on another member's question
  still wakes nobody.
