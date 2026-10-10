---
section: For developers
---
- The merge train counts a green CI run on a commit only when that run tested what the pull request's own files need. CI plans each run from the files changed against the base the pull request had then, so a second run of the same commit for another base could skip the heavy jobs, turn green, and land a pull request or a batch whose own CI was red. Such a run is now passed over and the run before it counts; with no other run the pull request waits until CI runs on it again.
