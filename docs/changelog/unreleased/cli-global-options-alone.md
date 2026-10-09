---
section: For developers / CLI
---
- `ghostly --pretty` or `ghostly -p bot` with no command shows the help, as `ghostly` alone does; before, it was "Unknown command: --pretty" (exit 2). `ghostly help` lists `version` (also `--version`), and `ghostly help version` answers it instead of "Unknown command: version".
