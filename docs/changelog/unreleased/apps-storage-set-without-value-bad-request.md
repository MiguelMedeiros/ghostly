---
section: Fixed / Apps
---
- An app's `storage.set` with no value is answered `bad-request`, as the app API says for arguments a call does not take. It was answered `too-large`, so an app told its person the value was too big.
