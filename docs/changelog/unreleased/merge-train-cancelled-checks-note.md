---
section: For developers
---
- When the merge train cancels a pull request's own full CI run (once it boards a batch, or while it waits behind the base on a green fast tier), its position comment now says that the cancelled checks are not failures and that a push would take it out of the line. Before, `gh pr checks` listed each cancelled job as "fail" next to a comment that only said "waiting for its CI".
