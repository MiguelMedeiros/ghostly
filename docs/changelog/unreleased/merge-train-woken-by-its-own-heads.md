---
section: For developers / CI
---
- CI ending on a pull request that is not in line no longer runs the merge train: the workflow checks whose head the run was on, and starts a base's train only when it is the head of a queued pull request or of a batch. In 23 hours, 105 of the 174 wakes by a pull request's CI were for one that was not in line, and the train ran in full for 47 of them with nothing to do. A head pushed after `queue` is seen when its own CI run ends, or at the next scheduled run.
