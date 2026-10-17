---
section: Fixed / Groups
---
- If you are the admin of several private groups whose links are on, your app no longer checks each link for people joining every 5 seconds on its own. With three links on and nobody joining, that was 36 relay requests a minute, all day, more than all the members of a group of 8 cost. Links nobody is using now share one pace: they are checked one at a time, in turn, every 5 seconds between them, so three or ten links cost what one did and each waits its turn (every 50 seconds with ten links). A link you just shared, or that someone just opened, is still checked every 2 seconds.
