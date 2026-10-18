---
section: Fixed / CLI
---
- `ghostly message delete <group> <message>` without `--everyone` no longer answers `No chat "<group>"`: it says the name is a group and gives the command that deletes its message, with `--everyone`. The usage line reads `message delete <chat|group> <message> [--everyone]`.
