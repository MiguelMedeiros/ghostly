---
section: Fixed / CLI
---
- `ghostly app publish` no longer takes seconds to minutes on a file holding many private key headers with no end (cut keys in a test fixture or a log). Each header was read to the end of the file again: 1 MiB of them took about 30 seconds, 4 MiB several minutes. Such a file is now read once, and a whole key in the folder is still refused.
