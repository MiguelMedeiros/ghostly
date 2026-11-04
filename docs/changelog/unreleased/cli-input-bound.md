---
section: Fixed / CLI
---
- `app send <chat> <app> -`, a card's `--json -` and the files a request carries (`--json <file>`,
  `identity complete --evidence-file`, `x401 credential add <file>`) stop at 16 MiB too and answer that more came
  (`bad_request`, exit 1): 600 MiB answered "Cannot create a string longer than 0x1fffffe8 characters". A request whose
  JSON passes 16 MiB all the same (a text's escapes) is refused before it goes to the daemon, naming the command and
  its size, where it answered "The daemon went away" while the daemon ran on.
