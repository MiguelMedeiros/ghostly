---
section: Fixed / Apps
---
- When an app's publisher put two different builds under one version number in two places (its own link and a mirror, or a store), the update check no longer downloads both whole at every visit to Apps (up to 16 MiB each), only to mark the app "Two different versions exist" again. Each is read whole once, then again only once that link serves another version or an hour has gone by.
