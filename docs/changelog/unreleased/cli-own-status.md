---
section: For developers / CLI
release: 1.11
---
- `ghostly status set "At lunch" --emoji 🍕 --availability busy --until 2h` sets the status your paired contacts see: a text of up to 60 characters, one emoji, available, busy, away or dnd (Do not disturb), and when it ends by itself. `ghostly status show` prints it, `ghostly status clear` takes it back; each answers `{"status": {...}}`, or `{"status": null}` when there is none. A text that is too long or holds a link, a word that is not one emoji, or a time already past is refused with exit 2. Plain `ghostly status` is unchanged, and the CLI never tells contacts it is online.
