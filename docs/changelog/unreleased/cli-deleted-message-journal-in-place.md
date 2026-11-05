---
section: Fixed / CLI
---
- A message deleted (here, or for everyone by its author) no longer makes the daemon write its whole event journal again: an old message's deletion held the daemon about 65 ms and wrote up to 16 MiB to disk. Its events are now written over where they are, and a deletion takes about 13 ms whatever the message's age.
