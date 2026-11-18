---
section: Fixed / Apps
---
- An app update a store lists at a link that can change (a repository's latest file) is now taken within about an hour when that link still served the old version at the first check. Before, the link was not looked at again until the store signed a new list or Ghostly restarted, so an app left open could stay on the old version for days. Links pinned to a commit work as before.
