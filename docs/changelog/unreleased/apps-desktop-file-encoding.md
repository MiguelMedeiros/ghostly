---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: on Desktop, a file an app reads with `ghostly.file()` no longer stalls the Ghostly window. Its bytes are turned into text on that window's thread before they go to the app's window, which took about 100 ms per MiB (over a second for a 16 MiB file). It now uses the same encoder as file transfers: about 12 ms for 16 MiB where the WebView has its own, about 80 ms elsewhere. The app gets the same bytes.
