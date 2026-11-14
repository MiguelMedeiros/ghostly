---
section: Fixed / CLI
---
- `ghostly file save --path <folder>/` for a folder that is not there now says there is no such folder (make it first, or name a file in a folder that is there). Before, it suggested `--dir <that folder>`, which then failed with "No such file or folder". A file at that path is named as a file, not a folder.
