---
section: For developers / CI
---
- When GitHub refuses the merge train's push of a lone pull request's rebase (a branch rule, or a push the queue app's token may not do), its position comment says so with GitHub's message, and the same refusal at the next run takes it out of the line with `queue:failed` and that message. Before, every run rebased it again and its comment said it was waiting for CI Success on a commit its branch never got.
