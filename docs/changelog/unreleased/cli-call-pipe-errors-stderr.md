---
section: Fixed / CLI
---
- `ghostly call pipe` writes its errors (no daemon, no call on, a call that has no audio yet) to stderr. They went to stdout, which carries only the call's audio, so in `ghostly call pipe | aplay -f S16_LE …` the error was played as a click and the terminal showed nothing. The exit codes are the same.
