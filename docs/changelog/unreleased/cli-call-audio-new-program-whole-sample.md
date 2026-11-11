---
section: Fixed / CLI
---
- A new program on a CLI call's audio no longer has its sound shifted by the previous program's half sample: a program that takes over the call's audio socket starts on an empty queue, so the contact hears it right away and as it was written, not as loud noise.
