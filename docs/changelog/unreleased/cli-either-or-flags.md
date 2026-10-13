---
section: For developers / CLI
---
- Flags the help gives as either/or are refused together, as a usage error (exit 2) that names both, where one of them won without a word: `profile picture <jpeg> --clear` and `group picture <group> <jpeg> --clear` cleared the picture, `task send --progress n --steps a/b` and `usage send --left n --used n --limit n` sent a card with both, `group link --off --reset` dropped the reset, and `group hub --pin --exclude` pinned.
