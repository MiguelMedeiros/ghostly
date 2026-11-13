---
section: Fixed / CLI
---
- CLI calls: a call that rang and could not be answered (the chat's connection went as the answer was sent, or its media could not start) now ends with `call.ended` (`failed`) and a line in the daemon's log, as every other call that rang does. A program or `listen` hook waiting on that call's end waited forever, and an auto-answered call failed with only a line on stderr.
