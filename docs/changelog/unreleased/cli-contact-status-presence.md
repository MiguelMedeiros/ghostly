---
section: For developers / CLI
---
- `chat show` and `chat list` say the status a contact set (`status`: text, emoji, availability, until; null when none or ended) and, when they share it, whether they are active or idle (`presence`); the event stream says `chat.status` when either changes. A bot can now tell that a contact set Do not disturb without `engine getState`.
