---
section: Fixed / CLI
---
- `ghostly invite join` and `ghostly group join` with no invite, run with stdin a pipe nobody writes (Node's `exec`, a supervisor, a bot's harness), no longer wait for ever without a word: after 2 s stderr says it waits for the invite on stdin, and after 60 s with nothing on stdin it ends with the usage error. A producer that started writing is waited for to the end, and `invite join -` still waits as long as it takes.
