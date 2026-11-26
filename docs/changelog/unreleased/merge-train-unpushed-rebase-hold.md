---
section: For developers / Tests
---
- The merge train leaves a lone pull request alone when it was put on hold, turned into a draft or got a running or "changes needed" review after the push of the train's second rebase of it failed. Before, the next run pushed that rebase anyway: a held branch was force-pushed, and since a review's hold ends on a new head, the train's own push ended it and the pull request could land with changes asked of it.
