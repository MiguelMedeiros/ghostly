---
section: Fixed / Everywhere
---
- An app over its relays' request budget no longer rebuilds and signs a held-back background packet every 4 seconds: it sends it again when the budget frees room for it (up to a minute). An idle app in several groups spent most of its publishing work on packets the budget refused again. Messages, offers and answers keep their turn as before.
