---
section: For developers
---
- The merge train no longer keeps a lone pull request in flight when none of its CI runs can count as its own (another pull request from the same branch into another base, or more than 1000 events). It waits in line saying why, and the pull requests behind it go on. Before, the train logged that CI never started, rebased and force-pushed it every 20 minutes for a new full CI run, and nothing else on that base landed.
