---
section: Fixed / Groups
---
- With wake-up push on (the installed web app), each change no longer looks through every chat once per private group to find the group's wake-up tokens: it looks once for all groups. Before, with 2,000 chats and 30 groups of 31, each change took about 1 ms more (74% more); now it costs the same as with wake-up push off.
