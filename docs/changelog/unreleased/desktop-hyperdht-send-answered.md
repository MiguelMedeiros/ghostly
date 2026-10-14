---
section: Fixed / Desktop
---
- On Desktop, a chat over HyperDHT no longer loses messages without a word when the app hands it frames faster than the link carries them (a file or a mini-app sending to a contact on a slow link): each frame is now answered once its connection has room, so the chat's send budget counts it until then and files and apps keep to their share, and a frame that could not go is a failed send instead of one dropped unseen.
