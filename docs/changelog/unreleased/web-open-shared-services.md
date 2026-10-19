---
section: For users / Everywhere
release: 1.5
---
- The web app opens a web app a contact shares with you, full screen, on an address of its own, over the chat's live link. A server that hosts the web app turns it on with a wildcard name for those apps (`GHOSTLY_SERVICES_HOST` and `GHOSTLY_SERVICES_APP_ORIGIN` in `infra/docker-compose.yml`); without one, the web app says opening needs the extension or the desktop app, as before. While it is open, the keyboard stays in it (Tab never reaches the chat hidden under it), and closing it puts the focus back on its Open button.
