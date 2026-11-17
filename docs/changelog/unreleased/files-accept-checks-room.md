---
section: Fixed / Files
---
- Accepting a file that waited for you now checks the free space on this device first. A file larger than the space left (beside the files still on their way) is no longer started only to fail part way with the disk full: it says there is no room, keeps waiting so you can free some space and accept it again, and the space shown on waiting files is read again. Accept stays available when a waiting file shows too little space, since that number may be old. On the CLI, `file accept` answers `refused` (`details.reason: "no_room"`, `details.room`) instead of starting it.
