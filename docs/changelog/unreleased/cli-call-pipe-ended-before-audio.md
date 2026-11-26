---
section: Fixed / CLI
---
- `ghostly call pipe` on a call that ended just before it reached the call's audio now says `No call <id>: it ended (ghostly call list)` (`not_found`, exit 3). It said "No such file or folder: the path", or Node's raw `connect ECONNREFUSED …` with exit 1.
