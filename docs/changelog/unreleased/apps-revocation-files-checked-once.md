---
section: Fixed / Apps
---
- The update check no longer checks every signature in an app publisher's revocation files again at each visit to the Apps page. Once the files beside an app and its sources added up to more than 16 MiB, every one of them was checked again at each check, up to several seconds of work each time. A file is now checked once while it stays the same, whatever its size.
