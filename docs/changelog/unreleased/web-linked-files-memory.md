---
section: Fixed / Apps
---
- On the web in Chromium, a folder you pick for an app no longer holds memory for every file in it until the page reloads. Ghostly kept the browser's handle to each picked file, about 8 KB each: 800 MB more for a folder of 100,000 files, whether or not the app read them. It now notes each file's size and date and gets the file again from the folder when the app reads it, keeping only the last few it read.
