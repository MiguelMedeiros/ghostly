---
section: Fixed / Everywhere
---
- Opening the app with many chats does less work while the page is still settling. Each chat's keys are worked out once per run instead of up to four times, which halves that part of the start: about 130 ms instead of 260 ms for 50 chats on a slow machine.
