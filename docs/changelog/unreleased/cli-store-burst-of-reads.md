---
section: Fixed / CLI
---
- A CLI daemon no longer stops answering for seconds or minutes when it reads many things from its store at once (a long outbox, a large group, an import). Its store started those reads one at a time and checked each against all the others: 5,000 reads with a write among them held the daemon for 36 s, and now take tens of milliseconds.
