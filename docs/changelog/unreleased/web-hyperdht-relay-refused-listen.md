---
section: Fixed / Web
---
- In the web app, a chat whose HyperDHT listen the relay turns down (its key still held by an earlier connection of the same profile, after a laptop wakes up or a reload) now fails at once when the relay says so, instead of after 20 seconds. A chat the relay stops listening for later no longer counts as reachable over HyperDHT.
