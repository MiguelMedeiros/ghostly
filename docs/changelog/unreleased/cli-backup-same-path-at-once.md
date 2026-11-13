---
section: Fixed / CLI
---
- Two `ghostly profile backup` to the same file at once through one daemon (a cron job's and one typed by hand): the one that writes the file gets its own backup there, and the other is refused because the file exists. Before, both wrote through one temporary file. One failed with a bare `ENOENT`, or the one that said it wrote a backup (unencrypted, say) gave the file the other's backup (sealed with another passphrase), or one cut short.
