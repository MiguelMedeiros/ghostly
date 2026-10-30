---
section: Fixed / Chat
---
- Sending a photo or video of up to 16 MB from the web app or Android no longer freezes the page while the file is checked. Its fingerprint (SHA-256) is now computed by the browser's built-in crypto, not by app code running on the page itself. On a phone, a 16 MB video froze typing and scrolling for about a second; the built-in crypto takes under 0.1 s.
