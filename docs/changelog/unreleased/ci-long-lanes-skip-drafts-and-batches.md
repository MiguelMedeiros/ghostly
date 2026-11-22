---
section: For developers / CI
---
- The Android e2e, Android native, CodeQL and Desktop media streaming workflows run on a ready pull request only: a draft runs none of them until it is marked ready, and a merge train batch runs none of them, since each of its pull requests already did. Their nightly, push and manual runs are unchanged.
