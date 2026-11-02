---
section: Fixed / CLI
---
- A command that waits (`send --wait`, `chat wait`, `file wait`, a one-shot `invite join`) says on stderr what it waits for once it has waited a second, on a terminal only. Ctrl-C now ends it with one line saying what became of the message or transfer (it is kept and still goes), the `interrupted` error and exit code 130; a command running the profile itself releases it first. Before, it showed nothing while it waited, Ctrl-C ended it with no word, and the profile's lock was left behind.
