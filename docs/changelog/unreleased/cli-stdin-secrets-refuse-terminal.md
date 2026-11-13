---
section: Fixed / CLI
---
- `ghostly x401 credential add -` and `ghostly wallet create … --stdin` typed at a terminal now answer at once with a usage error that says to pipe the credential or the name=value lines to them, as `invite join -` and `identity add --stdin` do. Before, they waited on the keyboard without a word until killed.
