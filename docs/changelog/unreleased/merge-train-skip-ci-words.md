---
section: For developers
---
- The merge train writes `[skip ci]` (and `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`) in round brackets in every commit message it composes. A queued pull request whose title or an earlier commit carried one made the batch's head commit hold it, so GitHub started no CI for the batch and the train rebuilt the same batch every 20 minutes for good.
