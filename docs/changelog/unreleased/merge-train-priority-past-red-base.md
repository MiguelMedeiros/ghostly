---
section: For developers / CI
---
- While CI Success is red on `dev` itself and the merge train holds a red batch (or a red pull request alone) for it, one pull request with `queue:priority` now goes ahead of it alone and can land the fix for `dev`; the held one waits and is rebuilt on the new tip once it lands. Before, nothing moved until someone re-ran `dev`'s CI, so a red that was no flake stopped the line for good. After 30 minutes on hold, the position comments say what to do. A `queue:priority` pull request whose commits do not rebase onto `dev` (it resolved a conflict in a merge of `dev`) leaves the line with `queue:conflict` and a comment saying to rebase it, and the next one goes.
