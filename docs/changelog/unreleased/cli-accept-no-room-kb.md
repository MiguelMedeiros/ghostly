---
section: Fixed / CLI
---
- `file accept` refused for lack of room on a nearly full disk says sizes under a megabyte in KB (or B), not "(0.1 MB) does not fit: 0 MB free", and a file a few bytes short of the room no longer reads as if it fit ("(61 KB) does not fit: 61 KB free"): what is needed rounds up and the room down. `file wait` and `file save` name a file under a megabyte in KB or B too.
