---
section: Fixed / CLI
---
- `ghostly task`, `routine` and `usage` send and update, and `ghostly button update`, refuse a `--text` over 16 KiB at once, as `send` does (`bad_request` with the text's size and the limit). Before, the secret check read the whole text first, so a long text that looked like a seed asked for `--force` and then failed anyway, and the refusal came back as `refused` without the size.
