---
section: For developers
---
- The merge train only takes as a batch a pull request it opened itself: a `batch/<base>-*` branch with the batch mark now also needs the train's own login as its author and at least one pull request in the mark. Before, any branch of this repository with that name and a hand-written mark was merged once its CI was green, and an open one with a lower number made the train close its real batch every run.
