---
section: Fixed / CLI
---
- `ghostly file save --dir` of a file whose name is already in that folder now says both ways out: `--force` replaces the file there, or `--path <folder>/<name> (2).<ext>` (the next free name) keeps both. Before, it said only "pass --force", and following that hint overwrote the other file, such as a second `image.png` over the first.
