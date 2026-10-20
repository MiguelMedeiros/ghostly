---
section: Fixed / CLI
---
- A file whose name starts with `~` (like `~notes.txt`, or Office's `~$report.docx`) can be given to the CLI again. Since 1.5.0 every such name was refused as if it named another user's home folder; only `~user/…` that does not exist is refused now.
