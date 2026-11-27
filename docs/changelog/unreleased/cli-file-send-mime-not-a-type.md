---
section: Fixed / CLI
release: 1.14
---
- `ghostly file send --mime` with something that is not a type (`text`, `text/plain; charset=utf-8`, an empty value) is now a usage error (exit 2) that names it. Before, the file went as `application/octet-stream` with exit 0, so the contact got a file to download instead of the picture or text asked for, and nothing said why.
