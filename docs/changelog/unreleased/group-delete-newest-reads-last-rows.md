---
section: Fixed / Groups
---
- Deleting a group's or community's newest message for everyone no longer makes every member's app read the group's whole history to put its unread and "@" marks back: it reads the last rows only. In a test with 1,500 messages, that step took about 3 ms instead of 13.
