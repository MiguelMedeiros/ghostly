---
section: For developers / Tests
---
- The merge train's wake (the job that starts the train when a batch held for company leaves) tries the start four times, 30 s apart, instead of once. One 503 from GitHub on that start (2026-11-25) left the held batch to the 15-minute schedule, which GitHub runs up to 30 minutes late, and turned the run red.
