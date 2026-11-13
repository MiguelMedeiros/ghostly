---
section: Fixed / CLI
---
- `ghostly settings`, `ghostly profile`, `group remove`/`group admin` and `service open` no longer read the list of every chat to check one setting: on a profile with 1,000 chats each spent 12-17 ms of the daemon's time on it (about 130 ms at 10,000), and a bot reading a setting before each reply paid it every time. A new chat's join notice reads only your name too.
