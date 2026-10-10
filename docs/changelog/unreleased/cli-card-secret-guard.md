---
section: For developers / CLI
---
- `task send/update`, `routine send/update` and `usage send` refuse a card whose text (title, step, items, a run's summary, links, `--text`) looks like a recovery phrase, a private key or a Cashu token, as `send` does (exit 5), unless `--force`. Before, a card took any of them to the chat without a word.
