---
section: Fixed / CLI
---
- `ghostly identity complete <draft> --stdin` (or `--evidence-file -`) run with nothing piped to it, at a terminal, is now a usage error saying to pipe the tool's output in or give `--evidence-file f`, as `identity add --stdin` does. Before, it waited on the keyboard without a word.
