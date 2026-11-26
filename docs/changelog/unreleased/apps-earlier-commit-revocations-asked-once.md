---
section: Fixed / Apps
---
- The update check of an app a store has updated many times no longer asks again, at every check, for the revocations file beside each earlier version's commit, which can never change (up to 16 more requests per app, one after another). It reads each of them once while Ghostly runs, and still asks where the app comes from now and its sources at every check.
