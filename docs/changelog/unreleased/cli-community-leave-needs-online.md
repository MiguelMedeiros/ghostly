---
section: Fixed / CLI
---
- `ghostly group leave` of a community nobody is connected to no longer says "Try again in a moment", which a command without a daemon could never pass: it says the leave needs a member connected, and without a daemon names `ghostly daemon --detach` first. An admin's `ghostly group forget` of such a community, refused the same way, says the same.
