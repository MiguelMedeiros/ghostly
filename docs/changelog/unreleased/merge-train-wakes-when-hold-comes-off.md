---
section: For developers / CI
---
- Taking `queue:hold` off a queued pull request starts a merge train run, so it boards at once. Before, nothing woke the train then, and the pull request waited for GitHub's schedule, which runs only every 10 to 30 minutes.
