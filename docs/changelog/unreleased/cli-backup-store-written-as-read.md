---
section: Fixed / CLI
---
- `ghostly profile backup` writes the profile's store as it reads it, a few hundred messages at a time, instead of holding the whole store in memory twice: with 400,000 messages the daemon took about 340 MB more memory and stopped answering for 0.4 s; now it takes a few MB more and goes on within a tenth of a second. The backup file and what it restores are the same.
