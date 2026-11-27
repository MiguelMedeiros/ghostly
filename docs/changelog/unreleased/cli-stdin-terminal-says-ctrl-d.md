---
section: Fixed / CLI
---
- A command that reads stdin from a terminal (`send --stdin`, `group send --stdin`, `edit --stdin`, `engine <method> -`, `app send … -`, a card's `--json -`) first says on stderr how to end what you type (Ctrl-D). It waited with no word, so it looked stuck. On a pipe or a file nothing changes.
