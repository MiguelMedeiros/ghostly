---
section: Fixed / CLI
---
- A number option given as `""`, such as an unset variable in a script, is now refused as `--left abc` is: `--left takes a number, not ""`. It was read as 0 and acted on: `usage send --all --left ""` posted "0% left" to every chat, `task send --progress ""` a card at 0%, `listen --since "" --exec` ran the hook over every event the journal holds, and `chat disconnect --hold ""` ended the hold.
