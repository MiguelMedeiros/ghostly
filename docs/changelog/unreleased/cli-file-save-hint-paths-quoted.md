---
section: Fixed / CLI
---
- The paths `ghostly file save` suggests in its hints (`--path` to keep both files, `--dir` for a folder) are now quoted for the shell, so pasting one works. Before, a name like `report (2).txt` was a syntax error in bash and zsh, and a folder with a space in it was split in two. The answer's `details` carries the path as it is, for scripts. A path that holds a quote or a backslash is not offered to paste, as the answer's JSON prints it escaped: the hint points at `details`.
