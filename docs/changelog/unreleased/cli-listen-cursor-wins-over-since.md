---
section: Fixed / CLI
---
- `ghostly listen --since <seq> --cursor <file>` now starts after the event the cursor file holds, and `--since` is only where the first start begins (no file yet). Before, `--since` won without a word, so a service written `--since 0 --cursor <file>` ran its `--exec` or `--webhook` again for every event already handled, up to the whole journal, at each restart. When both are given and they differ, stderr says which one was used.
