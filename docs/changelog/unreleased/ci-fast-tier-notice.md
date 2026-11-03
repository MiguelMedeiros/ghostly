---
section: For developers / CI
---
- CI's notice on a green fast tier no longer says "Draft:" and asks for `gh pr ready` on a pull request that already left draft, and no longer says the required CI Success comes from the full run, which the merge train may cancel once it boards the pull request on the fast tier. A draft is told that the train may board it on this run once it is ready; a pull request that left draft while the run went is told that the full run waits behind it.
