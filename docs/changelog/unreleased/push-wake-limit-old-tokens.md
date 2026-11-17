---
section: Fixed / Web
---
- The installed web app's push worker no longer keeps, for good, when it last showed a notice for wake-up tokens that are gone. Each time a chat was muted or deleted with wake-ups on, or push was turned on again, every chat got a new token, and the old tokens' times stayed in the browser's storage until push was turned off. Now each wake-up drops the times that can no longer hold a notice back (older than the longest wait, 30 minutes).
