---
section: For developers
---
- The test of a daemon's relay reads after the device clock is set back checks the reads' rate and that no minute stalls, not more than 30 reads in every single minute: on a loaded runner one fake minute's reads spilled into the next, so it failed now and then with "expected 20 to be greater than 30" while every contact was read.
