---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: the data export offered before an uninstall keeps what an app stored under a key named `__proto__`. Before, that entry was missing from the file, and the uninstall then deleted it.
