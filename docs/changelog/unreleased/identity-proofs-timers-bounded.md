---
section: Fixed / Everywhere
---
- An app or CLI daemon left running no longer holds on to more and more spent timers of the identity proofs' hourly republish and 15-minute re-check (5 more an hour, about 3,600 after a month): it keeps only the ones still to come.
