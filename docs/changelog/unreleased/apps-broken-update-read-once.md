---
section: Fixed / Apps
---
- When a newer version of an installed app is broken where it is published (a file that does not match its manifest, a bad signature), the update check no longer downloads it whole again at every visit to Apps, from each link a store or the app names (up to 16 MiB each). It is read whole once, then again only once that link serves another version or an hour has gone by.
