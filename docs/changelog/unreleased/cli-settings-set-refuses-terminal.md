---
section: Fixed / CLI
release: 1.14
---
- `ghostly settings set <key> -` on a terminal is refused at once with the usage error (exit 2), as every other value the CLI takes on stdin refuses a terminal: pipe the value in (`… | ghostly settings set iceServers -`). It waited for the keyboard with no word, and a value typed there showed on the screen. Through a pipe it reads the value as before.
