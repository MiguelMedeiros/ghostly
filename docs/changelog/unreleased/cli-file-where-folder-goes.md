---
section: Fixed / CLI
---
- `ghostly store sign --out`, and `app publish --key` or `--out`, given a path where a file stands in place of a folder now say "<path> is a file, not a folder" (`not_found`, exit 3). Before, they answered `engine` (exit 1) with Node's raw "EEXIST: file already exists, mkdir".
