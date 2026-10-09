---
section: For developers / CI
---
- The merge train's own pushes to `dev` or an epic no longer start a merge-queue run each: a batch landing as one squash merge per pull request started one per pull request, each taking a runner only to be cancelled or to find nothing to do. A person's push still wakes the train.
