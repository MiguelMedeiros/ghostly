---
section: Fixed / CLI
---
- `ghostly profile backup` of a profile with many small files takes about half the time. Each frame is now sealed (or chained) at once, and frames are written together, where before each took one WebCrypto call and one write. 50,000 files of 1 KB went from 16.2 s to 8.6 s with a passphrase, and from 12.6 s to 6.9 s without.
