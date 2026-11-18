---
section: Fixed / CLI
---
- A call placed with `call start`, or answered by hand with `call answer`, with no `--rate` is at 48000, as the help and the docs say. Before, it took the rate set with `call auto on --rate`, even when auto-answer was for other chats only, and a program reading the audio at 48000 heard it three times too slow. Auto-answer still answers at its own rate.
