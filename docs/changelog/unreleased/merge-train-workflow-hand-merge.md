---
section: For developers / Tests
---
- The merge train no longer boards a pull request that changes `.github/workflows/` into a batch, where GitHub refused the batch's push (the queue app has no `workflows` permission) and the pull request left the line with `queue:failed`. Up to date with `dev` and green, it lands alone with GitHub's squash merge, which pushes nothing. Behind `dev` (or into an epic), it leaves the line with `queue:hand-merge` and a comment that tells a coordinator how to update and land it, and the train takes that label off once it gets `queue` again.
