---
section: Fixed / Everywhere
---
- The app no longer draws its open chat again on every change elsewhere in the app, nor any chat it keeps loaded behind for a mini-app or a call. Each change, up to 20 a second while a file moves, made the app's frame and every loaded chat draw again. Now a chat draws only when something it shows changes. In a test, 20 changes elsewhere caused no draws; before, each one drew the frame and every loaded chat.
