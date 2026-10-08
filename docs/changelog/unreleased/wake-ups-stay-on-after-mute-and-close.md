---
section: Fixed / Web app
---
- Wake-ups no longer turn themselves off when you close the web app right after you mute a chat or delete a contact. The app replaces its push subscription then, and a page that was being closed read notifications as blocked and switched wake-ups off for good, with nothing said. Now a page that is hidden waits until you see it again before it believes that notifications were taken away.
