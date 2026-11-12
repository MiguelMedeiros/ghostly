---
section: Fixed / CLI
---
- `file send --voice` of a small WebM or Ogg file that declares a huge number of empty sound packets no longer runs the daemon out of memory while it measures the voice note: it reads as many packets as the longest voice note can hold, and such a file is refused as too long.
