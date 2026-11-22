---
section: Fixed / CLI
---
- `ghostly profile backup --out` and `ghostly listen --cursor` with a path under a file (`notes.txt/b.bin`, `notes.txt` a file) now say "notes.txt is a file, not a folder", as `file save` does. Before, they said "No such file or folder: notes.txt", about a file that is there. The error code is still `not_found` (exit 3).
