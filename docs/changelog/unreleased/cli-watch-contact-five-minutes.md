---
section: Fixed / CLI
---
- A CLI daemon keeps looking for a contact that went away (a phone that put the app to sleep) every 10 seconds for 5
  minutes, not every 30 seconds past the first 2: a phone back after 2 to 5 minutes is live again within seconds where
  WebRTC is the only way between them.
