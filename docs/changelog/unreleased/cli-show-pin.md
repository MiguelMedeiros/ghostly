---
section: Fixed / CLI
---
- `chat show`, `group show` and `group list` now say what is pinned: `pin: {messageId, ref, by, at}`, with the same fields `chat.pinned` and `group.pinned` carry, or `pin: null`. Before, no read command showed the pin, so a bot that started after it (or whose journal was trimmed) could not learn the pinned message.
