---
section: Fixed / Groups
---
- A group file whose sender went away mid-way, and whose download was then stopped right away (another member having it), keeps what came exactly once: its last gathered part (up to 256 KiB) could be written twice, so the next member's bytes made a file that failed its check and was fetched again from the start.
