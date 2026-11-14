---
section: Fixed / CLI
---
- `ghostly invite join … --label <name>` run without a daemon, when the inviter is offline, now suggests `ghostly chat wait <chat> --until paired` with the chat's id when the label would not paste as typed. Before, only a label with a space did that: `--label "O'Brien"` suggested a line the shell held open for a closing quote, `$work` named no chat, and a backtick in the label ran a command when pasted.
