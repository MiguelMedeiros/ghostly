---
section: Fixed / Web
---
- On the web, a contact's shared app that makes a worker from its own code (a `blob:` URL) works again. Since 1.11.1 such a worker could not load its other scripts (`importScripts`) or evaluate code; now it runs as it does in a browser tab. The same goes for the Desktop app with Hide my IP from contacts on.
