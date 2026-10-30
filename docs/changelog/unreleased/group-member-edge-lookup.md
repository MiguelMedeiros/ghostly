---
section: Fixed / Groups
---
- With many large groups, the app no longer slows down each time it updates: it finds a member's connection by their key instead of searching every connection once for every member of every group (communities included). With ten private groups of 32 and ten communities of 256, each update takes about 3 ms instead of 8 ms, and every CLI command sent through the daemon gets that time back too.
