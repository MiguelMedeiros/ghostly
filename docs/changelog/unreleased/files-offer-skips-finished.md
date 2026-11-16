---
section: Fixed / Files
---
- A file a contact sends is answered without going through every file the profile ever sent or received. Each incoming file read all of them, in every chat, to count what is still on its way: on a long-lived profile with 100,000 files that took about 10 ms per file, a few hundred ms to a second for a batch of photos on a phone. It now reads only the transfers still under way.
