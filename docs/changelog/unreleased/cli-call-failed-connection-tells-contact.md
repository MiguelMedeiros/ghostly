---
section: Fixed / CLI
---
- CLI calls: a call whose connection fails now hangs up to the contact, as the apps do. It ended on the daemon's side with nothing said, and the contact's app went on saying "Connecting..." (up to 45 s) or "Reconnecting..." for a call that was over.
