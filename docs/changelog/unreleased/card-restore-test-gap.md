---
section: For developers / Tests
---
- The browser engine's card-restore test no longer waits out the real 30 s between two looks for cards that went as text: it shortens the gap to 6 s through `cardRestoreTiming`, as the quote sweeps' tests do. The file runs in about 40 s instead of 65 s.
