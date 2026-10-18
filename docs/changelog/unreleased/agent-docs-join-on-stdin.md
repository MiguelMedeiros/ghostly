---
section: Fixed / CLI
---
- The agent guides (`packages/cli/SKILL.md` and the owner skill) join an invite or a group's link on stdin, `printf '%s' '<link>' | ghostly invite join --label owner`, as the CLI asks, instead of on the command line, where it shows in `ps` and the shell's history and the CLI warns about it.
