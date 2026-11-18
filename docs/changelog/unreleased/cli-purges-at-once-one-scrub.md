---
section: Fixed / CLI
---
- Several `message delete --purge` at once (a script, or another client on the daemon's socket) now share one rewrite of the profile's store instead of one each, and the daemon answers meanwhile. Each wrote the whole store file again with the daemon held: ten at once on a profile of 100,000 messages held it about 15 s, up to 4.6 s at a stretch; now under a second. Each purged message is still gone from the profile's folder before its command answers.
