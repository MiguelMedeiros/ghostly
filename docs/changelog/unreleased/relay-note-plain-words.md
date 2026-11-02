---
section: Fixed / CLI
---
- The note a command writes on stderr when a relay does not answer reads in plain words: `ghostly: relay 127.0.0.1:1 did not answer; asked again in 60 s`. Before, it read `[ghostly:relay] 127.0.0.1:1 tripped (no answer); left alone for 60 s`.
