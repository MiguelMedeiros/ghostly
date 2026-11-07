---
section: Fixed / CLI
---
- A mistyped global option before the command (`ghostly --porfile bot send alice hi`, `ghostly -x status`) is now refused as an unknown option that names the one meant, `Unknown option --porfile (did you mean --profile? ghostly help)`, the way the same typo after the command is, instead of `Unknown command: --porfile`. It is still a usage error (exit 2).
