---
section: For developers / CLI
---
- A daemon (or a command run without one) that starts after a crash no longer builds the indexes of every stored row again for each store its last writes touched: it brings them in step for the rows those writes changed. With 60,000 stored messages, a start after a kill that had one message to recover spent about 5.5 s on that.
