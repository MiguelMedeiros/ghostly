---
section: Fixed / Groups
---
- On the web, in the extension and in the desktop app, the signature of each message a community brings is checked with the browser's built-in Ed25519 instead of the app's portable one, where the browser has it and it passes a check at start: in Chromium a catch-up of 256 messages takes about 27 ms of the page's time instead of 170 ms. What a check accepts is unchanged.
