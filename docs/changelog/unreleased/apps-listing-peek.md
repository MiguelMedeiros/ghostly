---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: the update check peeks at a store listing's URLs (the bundle's first 64 KiB) before reading a bundle whole, as it already did for an app's sources. A listing that names a version its URLs do not hold, or a raw HEAD link that moved on, no longer downloads the whole bundle at every Apps page visit, and is not peeked again until the store's index changes.
