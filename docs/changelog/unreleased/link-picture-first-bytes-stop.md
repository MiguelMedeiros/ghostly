---
section: Fixed / Chat
---
- In the web app and the browser extension, a link preview's picture or a picture link whose first bytes are not a picture, or say a size too large to show, is no longer downloaded whole (up to 5 MB) before it is refused: reading stops at those first bytes. The Desktop app is unchanged.
