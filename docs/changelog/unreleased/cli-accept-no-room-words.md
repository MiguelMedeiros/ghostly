---
section: Fixed / CLI
---
- `file accept` refused for lack of room now says it in the CLI's own words and MB: the file's name and size, the room left, the files still coming that need it first, and the way out (free some space and accept it again, or `file decline`). It said "No room on this device for this file (38.8 MB free)" for a 27.3 MB file, the room counted in different MB than the size, with nothing about the other file still coming.
