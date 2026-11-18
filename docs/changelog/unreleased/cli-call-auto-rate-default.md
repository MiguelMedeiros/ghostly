---
section: Fixed / CLI
---
- `call auto on` with no `--rate` (and the socket's `call.auto` with no `rate`) answers at 48000, as the help and the docs say. Before, it kept the rate an earlier `call auto on --rate` set, so a program set up for 48000 heard the calls three times too slow.
