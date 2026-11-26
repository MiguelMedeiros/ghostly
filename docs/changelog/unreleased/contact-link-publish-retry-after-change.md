---
section: For developers
---
- The engine's contact link (the owner's side, not in the app yet) tries a failed publish again 5 minutes later when it ran right after a change (a new link, Turn off, a request taken, a busy link open again). Before, it waited for the hourly one, so a new link, its `off` or the link's busy or open state could stay unpublished for up to an hour.
