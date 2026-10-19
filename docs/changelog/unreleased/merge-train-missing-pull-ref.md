---
section: For developers
---
- The merge train no longer stops the whole line when GitHub has no `refs/pull/<n>/head` for one queued pull request: it fetches that one's head from its branch, and a pull request it cannot fetch at all leaves the line with `queue:failed` and a comment while the rest go on.
