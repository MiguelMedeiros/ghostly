---
section: Fixed / CLI
---
- `ghostly file save --dir` of a voice message now steps on to the next free name when the folder already holds a folder of that name, as it does for a file. Before, it stopped and said to use that folder as `--dir`. A `--path` that names a folder is still refused.
