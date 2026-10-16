---
section: Fixed / CLI
---
- `ghostly x401 credential add --label` keeps a label on one line: line breaks and tabs read as one space, as in a group's name. A label past 80 characters is refused with that rule. Before, it was cut at 80 without a word. The command's help names the limit.
