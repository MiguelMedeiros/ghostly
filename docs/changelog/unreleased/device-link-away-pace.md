---
section: Fixed / Everywhere
---
- A profile on several devices no longer reads a device that is away (a phone closed for the day) every 4 seconds for the first ten minutes after each start. That took half of a relay's minute per away device while your chats were reconnecting. Its link is now read every 30 seconds from the start, the same as after those ten minutes: 150 reads in that window went down to 20. A device that comes back is still connected within a minute.
