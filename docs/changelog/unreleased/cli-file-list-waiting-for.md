---
section: Fixed / CLI
---
- `ghostly file list` now says whose decision a file waits for: a received file over 25 MiB (or a group's file that did not come by itself) shows `waitingFor: "me"`, as `ghostly file accept` takes it, and a file sent from here that the contact has not taken yet shows `waitingFor: "contact"`. Before, both showed only `state: "transferring"`, as if they were moving.
