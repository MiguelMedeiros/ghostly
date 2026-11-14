---
section: Fixed / CLI
---
- `ghostly identity complete <draft> --evidence-file -` now reads what the tool printed from stdin, as `--stdin` does. Before, it looked for a file named `-` and answered "No such file or folder".
