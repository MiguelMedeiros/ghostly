---
section: Fixed / Web
---
- On the web app and in the browser extension, attaching to the Ghostly peer (the web app's start, and the extension's pages each time its peer starts again) no longer reads every saved key again for each chat to find where that chat's messages go: the chats' keys are read once for all of them. With 2,000 chats and nothing new, that attach went from about 500 ms to under 30 ms in a test with an in-memory store. The chat list's search in the extension finds the chats the peer answered with the same way.
