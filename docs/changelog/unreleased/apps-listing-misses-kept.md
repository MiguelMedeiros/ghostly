---
section: Fixed / Apps
---
- The update check no longer keeps a note of every app store listing address it looked at for as long as the app runs: a store that lists new addresses at each update grew the app's memory at every check. It keeps only the addresses the last check looked at, and a removed store's go with it.
