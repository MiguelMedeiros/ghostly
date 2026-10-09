---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: the update check reads the publisher's revocations before it takes a newer version, so a version revoked in `ghostly-revoke.json` is not installed. Before, it replaced the working version with the revoked one and deleted the old files, and the app stopped running.
