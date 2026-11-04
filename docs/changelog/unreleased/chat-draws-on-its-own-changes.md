---
section: Fixed / Everywhere
---
- An open chat, and a chat kept loaded behind it for a mini-app or a call that runs in it, no longer draws again on every change in the app. Each change made every loaded chat draw itself again, up to 20 times a second while a file moves: now a chat draws again only when something it shows changes (in a test, 0 draws for 20 changes elsewhere, where there were 20 per chat).
