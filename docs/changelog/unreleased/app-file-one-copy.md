---
section: Fixed / Apps
---
- A file an app reads from its own bundle (`ghostly.file`) was copied twice on the web page's thread before the app got it. It is now copied once, which halves what each read of a large file costs.
