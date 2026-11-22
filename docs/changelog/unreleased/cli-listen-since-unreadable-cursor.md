---
section: Fixed / CLI
---
- `ghostly listen --since N --cursor <file>` refuses a cursor file it cannot read (left another user's by a `sudo` run, say) or a folder, as it already did without `--since`. Before, `--since` started over without a word, and every event the cursor had already handled went to the `--exec` hook or the `--webhook` again; with a folder the hook ran on the first event before the refusal, at each restart.
