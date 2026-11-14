---
section: Fixed / CLI
---
- `ghostly file send … --voice 2s` (or `1.5s`, `2000ms`) now says `--voice takes a length in milliseconds, not "2s"`. Before, it answered a bare "Too many arguments" with the usage line, which did not say `--voice` was the problem.
