---
section: For developers / CI
---
- The merge train takes up to 12 pull requests in a batch instead of 5, and a ready pull request boards once the draft's fast tier (CI Success (draft)) passed on its last commit, without waiting for its own full CI: the batch's full CI run is still what lets anything land, and a red batch is still split until the culprit is found. When a pull request boards, the train cancels its own full CI run still going, so the runners go to the batch; a token that may not cancel workflow runs skips that with one line in the log. A pull request alone in line still waits for its own CI Success.
