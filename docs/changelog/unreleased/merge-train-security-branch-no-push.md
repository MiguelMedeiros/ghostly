---
section: For developers
---
- The merge train no longer rebases and pushes a lone queued pull request whose head branch is `claude/security-auto-*` (or `master`): it goes in a batch, like `dev`, `main`, `epic/*` and `batch/*` heads. A push to `claude/security-auto-*` is what the security autorelease ships once CI is green, and the train's rebase put `dev`'s unreleased commits on that branch.
