---
section: Fixed / CLI
release: 1.14
---
- `ghostly profile restore` of a backup whose profile is still in the same home no longer makes a second copy of the same person without a word: it is refused, naming the profiles it matches (a shared chat key or DID key), and `--copy` restores it anyway. Two restores of one backup run at once make one profile: the one that ends second is refused the same way.
