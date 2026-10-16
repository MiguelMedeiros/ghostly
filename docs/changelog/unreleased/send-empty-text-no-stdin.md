---
section: Fixed / CLI
---
- `ghostly send`, `edit`, `group send` and `group edit` with an empty text argument (`send bob ""`) answer "No text" when stdin is a pipe or a file. Before, they read stdin as the text, so in `while read line; do ghostly send bob "$line"; done < file` an empty line sent the rest of the file as one message and ended the loop. Stdin is read only when no text is given at all, or with `--stdin`.
