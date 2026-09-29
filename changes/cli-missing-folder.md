---
section: Fixed
---
- `ghostly file save --dir` and `ghostly profile backup --out` into a folder that does not exist now fail with `not_found` (exit 3) and the path, as a missing input file does, rather than `engine` (exit 1) with Node's `ENOENT` text. A path it may not write is `refused`, and a folder named where a file goes is `bad_request`.
