---
section: Fixed / Groups
---
- With a group open, the app no longer reads every chat's stored messages again each time something changes (a member comes or goes, someone types): with 150 chats that was 5 MB read and about 14 ms of work each time. A member's nickname is read from that contact's chat only, and only when it changed.
