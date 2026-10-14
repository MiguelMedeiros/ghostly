---
section: For developers / CLI
---
- The secret guard on `task`, `routine` and `usage` cards reads a card's text as the card carries it too. A card's lines lose their invisible characters (a zero-width space, a soft hyphen, an escape) on the way, so a key one of them broke in two passed the guard and went out whole; now it is refused (exit 5) unless `--force`.
