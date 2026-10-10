---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: a running app's storage calls, file reads and the messages it sends no longer each read the app's installed record from the device's database again. It is read once and kept until it changes (an update, its publisher's revocations, an uninstall). A run of 172 such calls made 172 reads of the record, now 1.
