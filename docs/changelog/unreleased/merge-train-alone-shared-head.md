---
section: For developers / CI
---
- The merge train no longer rebases and force-pushes the branch of a pull request alone in line when that branch is also the head of another open pull request (into another base), or when it cannot read the full list of pull requests the branch heads: such a pull request goes the batch way, which pushes nothing to its branch. Before, the push moved the other pull request's head too (an epic's pull request then carried `dev`'s commits), and the next run refused the lone one's green CI as not its own, so neither moved.
