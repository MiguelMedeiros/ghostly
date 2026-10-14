---
section: For developers
---
- The merge train no longer stops for good on a pull request that changes a workflow. The queue app may not push a branch whose commits change `.github/workflows/` (its token has no `workflows` permission), so every run failed on that batch's push and the whole line waited. Now such a refusal takes the pull requests that change a workflow out of the line with `queue:failed` and a comment saying why, and the rest board without them.
