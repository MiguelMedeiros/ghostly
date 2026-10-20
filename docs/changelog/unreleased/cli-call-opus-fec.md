---
section: Fixed / Calls
---
- A CLI bot's voice holds up better on a lossy connection. The CLI now sends Opus in-band FEC, as its call offer already announced, so the app rebuilds an isolated lost packet instead of covering it with a guess. At 10% loss, the app covered about 10% of the bot's speech before and 1.3% now, at the same bitrate.
