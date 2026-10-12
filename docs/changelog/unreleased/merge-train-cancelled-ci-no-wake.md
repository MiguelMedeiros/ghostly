---
section: For developers
---
- A cancelled CI run on a pull request no longer wakes the merge train. Such a run says nothing about its commit (a newer push or leaving draft replaced it, or the train cancelled it when the pull request boarded a batch), and the run that replaced it wakes the train when it ends. In 23 hours, 46 of the 174 wakes by a pull request's CI came from a cancelled run, and the train ran in full for 29 of them with nothing to do.
