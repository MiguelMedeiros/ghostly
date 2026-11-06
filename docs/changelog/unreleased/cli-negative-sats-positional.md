---
section: Fixed / CLI
---
- A negative amount given to `wallet receive`, `chat pay` or `chat request` (`ghostly wallet receive -5`) is now refused as the amount, `<sats> takes a whole number from 1 up, not -5`, the way a number flag is refused, instead of as `Unknown option -5`. A zero, a fraction or a word there reads the same way. It is still a usage error (exit 2).
