---
section: Fixed / CLI
---
- A command stopped by SIGTERM (`timeout 30 ghostly send … --wait delivered`, a service manager's stop) or by its terminal or SSH session closing (SIGHUP) now answers as on Ctrl-C: the `interrupted` error on stdout, a line on stderr saying what became of what it waited on (a text "is kept here and goes with this profile's next command"), its profile closed first, and exit 143 or 129. It ended on the spot with nothing said and its lock left behind, so a bot that saw no answer sent the text again.
