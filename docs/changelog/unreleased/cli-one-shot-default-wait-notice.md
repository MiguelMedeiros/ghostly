---
section: Fixed / CLI
---
- Without a daemon, a `file send`, `react`, `pin`, `group react`, `message delete --everyone`, task, routine or usage card, or `button press` that waits on its own (no `--wait` given) now says on a terminal what it waits for after a second, as `send --wait` does. Ctrl-C then says the file or message is kept and goes with the profile's next command. Before, a one-shot `file send` could sit silent for up to 300 s, and Ctrl-C said only that it stopped before the command answered.
