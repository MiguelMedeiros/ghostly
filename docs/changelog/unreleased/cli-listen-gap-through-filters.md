---
section: Fixed / CLI
---
- `ghostly listen --type …` and `listen --turns` now pass `events.gap` through. A bot listening to `message.received` (the documented echo bot) was never told that messages were lost across a crash, a full disk or the journal's trim: the gap was dropped and its cursor moved past it.
