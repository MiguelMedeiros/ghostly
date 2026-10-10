---
section: For developers / CI
---
- The merge train no longer drops a pull request alone in line as `queue:conflict` when its conflict was already resolved by merging the base into it. The lone path rebases the branch, and a rebase skips that merge, so the conflict came back; such a pull request now goes the batch way, whose squash merge takes the branch as it is, and only a conflict there takes it out of the line. The train's conflict comment now says that merging the base in works as well as rebasing.
