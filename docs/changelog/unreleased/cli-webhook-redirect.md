---
section: For developers / CLI
---
- `ghostly listen --webhook` no longer follows a redirect: a loopback bridge that answers 307 or 308 counts as not taking the event (retried, then said on stderr), instead of the event, message text included, being posted again to the address the redirect named, off this machine too.
