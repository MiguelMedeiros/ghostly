---
section: Fixed / CLI
---
- A `~` the shell left alone (`--home=~/bots`, a quoted `GHOSTLY_HOME="~/bot"`, a unit file's `Environment=` line, `--out=~/bk.backup`) is now your home folder. Before, the CLI made a folder named `~` in the current one and a brand-new profile in it, with no word. `~user/...` is refused: write the folder in full.
