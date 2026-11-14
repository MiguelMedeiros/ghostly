---
section: Fixed / CLI
---
- `ghostly file send <chat> <path> --voice "$MS"` with `MS` unset (an empty value) now says `--voice takes a length in milliseconds, not ""`. Before, it answered "Too many arguments" with the usage line, or `Missing <path>` when `--voice` came before the path, which was given.
