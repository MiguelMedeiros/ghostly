---
section: Fixed / CLI
---
- A command that reads stdin stops at 16 MiB, the most a daemon's request line holds, and answers that more came
  (`bad_request`, exit 1) at once. Before, it read the pipe to its end: `send bob --stdin < big.log` with 1 GiB took
  3 GB of memory and answered "Cannot create a string longer than 0x1fffffe8 characters", 128 MiB to
  `settings set nick -` crashed the CLI, an endless pipe never ended, and past 16 MiB a running daemon answered
  "The daemon went away".
