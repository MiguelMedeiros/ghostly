---
section: For users / Everywhere
release: 1.11
---
- With Hide my IP from contacts on, a contact's shared web app runs with WebRTC taken out of its pages in the Desktop
  app and the web app, so a server the contact names is not shown this device's address through a WebRTC connection
  the app makes. In the web app this is a guard inside the app's pages, not a browser rule: an app written to get
  around it can still reach WebRTC from a frame it reads by its index while the frame's page loads, or from a frame
  in a shadow tree written in its own HTML.
