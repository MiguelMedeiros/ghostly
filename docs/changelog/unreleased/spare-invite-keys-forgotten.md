---
section: Fixed / Everywhere
---
- An app or CLI daemon left running no longer keeps, in memory, what it published for each invite it prepared in advance and never handed out. It prepares a fresh one every 15 minutes, and each old one stayed for as long as it ran: about 5,500 keys after a month of uptime.
