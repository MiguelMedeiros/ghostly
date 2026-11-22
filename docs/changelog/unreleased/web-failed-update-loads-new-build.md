---
section: Fixed / Web
---
- Reload on "New version" in the web app no longer opens the old version again and again when the new version could not be saved for offline use (a file missing on the server, a full phone, a connection lost on the way). Once the server confirms the new version is out, the page loads it from the network and saves it for offline use again at the next start. Offline, or when the server does not answer, Reload keeps the version that opens without a connection.
