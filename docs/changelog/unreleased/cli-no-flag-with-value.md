---
section: Fixed / CLI
---
- `ghostly events --no-pretty=true` (any `--no-<flag>=value`) answers `--no-pretty takes no value`, as `--pretty=maybe` does. Before, it answered `Unknown option --no-pretty … (did you mean --no-pretty?)`, suggesting the very word typed.
