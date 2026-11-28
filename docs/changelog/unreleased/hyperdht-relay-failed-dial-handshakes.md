---
section: Fixed / Relays
---
- An app that reaches the HyperDHT through a relay (the web app, the extension, Hide my IP from contacts) no longer keeps
  a little memory (about 2 KB) for every dial that failed after it started, such as each try to reach a contact whose
  Desktop has just quit or a peer that refuses, for as long as its relay connection stays open.
