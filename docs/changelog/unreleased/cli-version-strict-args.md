---
section: Fixed / CLI
---
- `ghostly version` and `ghostly --version` answered the version for anything after them, so a typo such as `ghostly version --json` looked like it worked. They now refuse a stray word or an unknown option with a usage error (exit 2), as every other command does.
