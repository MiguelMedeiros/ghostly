---
section: Fixed / CLI
---
- A message deleted here, or by the contact for everyone, now reads the daemon's event journal only from the message's first event on. Before, each deletion read the journal's whole last 32 MiB from disk and searched it: 50 deletes on a 29 MiB journal took about 800 ms of the daemon's thread, now about 100 ms.
