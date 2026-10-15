---
section: Fixed / Apps
---
- On the web, an app with links to a large folder (up to 100,000 files) made Ghostly pause each time it let go of one of them: every forget wrote the folder's whole list again, about 75 ms of the page at 100,000 files. A forget now writes only the file it lets go of.
