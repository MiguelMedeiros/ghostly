---
section: For developers / CLI
release: 1.11
---
- With Hide my IP from contacts on, `service open` opens no app and says why (`unavailable`): the app would run in an
  ordinary browser tab, where nothing keeps its page from opening a WebRTC connection that shows a server the contact
  names this machine's address. The browser extension refuses the same way.
