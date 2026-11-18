---
section: Fixed / Apps
---
- The web app no longer downloads the whole apps runner page at every start only to check its security header: it asks the server whether the page changed and reads the header from the short "unchanged" answer. That is about 9.6 KiB less at each start, most of what a start downloads once the app is saved for offline use.
