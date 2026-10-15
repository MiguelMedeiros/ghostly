---
section: For developers
---
- The merge train now cancels a queued pull request's own full CI run while it waits in line, not only once it boards a batch, when its head is behind the base and its fast tier is green. Such a head never lands on that run: it lands on the batch's CI, or alone on the run of the train's rebase. On 2026-10-14, from 13:00 to 20:00 UTC, none of the 56 pull requests that landed used that run, and the 58 runs took about 1,700 Linux and 290 macOS runner-minutes away from the batches.
