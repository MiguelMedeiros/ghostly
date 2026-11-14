---
section: For developers / Tests
---
- A ready pull request that already has `queue` and is behind its base runs only CI's fast tier (CI Success (draft)): the merge train boards it on that, and its batch's full run is the gate. At the base's tip, where the train rebases a lone pull request, it still runs everything. Add `queue` before `gh pr ready` once the fast tier is green.
