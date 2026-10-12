---
section: Fixed / Apps
---
- Apps, Add: a link written with `http://` to GitHub or jsDelivr (`http://github.com/owner/repo`) is read as its `https://` link. Before, it was refused as "not an app, paste the repository's link", though it was the repository's link. Nothing is asked over `http://`.
