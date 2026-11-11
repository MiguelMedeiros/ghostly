---
section: Fixed / CLI
---
- `ghostly app init`'s `next` line is the line the answer prints. For a folder with a `'`, a `"` or a backslash in its name, the JSON answer printed the line with extra backslashes, so a copy pasted into a shell was another command. A name like `x'; echo hi #` ran `echo hi`. The line now says `<the folder>` instead, and the folder is in `dir`. A folder with a space or a `$` still gets the quoted, pasteable line.
