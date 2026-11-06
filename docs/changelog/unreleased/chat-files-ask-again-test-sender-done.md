---
section: For developers
---
- The test of asking again for a file that stopped arriving waits for the sender to be done: it read the sender as soon as the receiver was done, a turn before the receiver's word reached it, so it failed now and then on a loaded runner with "expected 'verifying' to be 'done'".
