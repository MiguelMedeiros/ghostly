---
section: Fixed / CLI
---
- `ghostly listen --type bogus` (a word that is no event family) now stops at once with a usage error naming the families, and a type no event has, such as the typo `message.recieved`, is said on stderr. Before, either was taken without a word and the listener stayed silent for good.
