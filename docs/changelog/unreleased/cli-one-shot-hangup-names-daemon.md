---
section: Fixed / CLI
---
- `ghostly call hangup` with no daemon running the profile now says calls need the daemon (`unavailable`, exit 1, `start it with ghostly daemon --detach`), as `call answer` and `call flush` do. It answered `No call is on` or `No call <id>: it ended or never existed` (`not_found`, exit 3), so a script read that no call was while a real one went unheld. A call that rings while the command runs is still declined. Scripts that check for exit 3 here get exit 1.
