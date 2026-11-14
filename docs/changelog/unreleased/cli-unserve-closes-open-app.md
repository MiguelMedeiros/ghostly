---
section: Fixed / CLI
---
- `ghostly app unserve` on a running daemon now closes the app in every chat where it was open, and the contact's app hears it close. Before, it only took the app off the served list: the contact's messages for it kept arriving as `app.message` events, and `app close` refused it as no longer served, so only a daemon restart ended it.
