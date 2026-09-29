---
section: Security / Everywhere
---
- A contact's shared app, opened in the extension or on Desktop, can only send real response headers: one whose value holds a line break, or whose name is not a header name, is dropped, and each cookie stays on the app's own address.
- The extension's background peer answers only the extension's own pages, like its service worker already did.
- Web app: the "Share to…" picker says the share came from another app or website, never picks a chat for you, and a share larger than 64 MiB is dropped before it is read.
- Web app: a contact whose app sends too many wake-ups cannot fill your screen. Each shows at most one "Incoming call" every 30 seconds and one "New message" every 5 minutes, whatever its app does.
- ghostly.tools and app.ghostly.tools tell browsers to use HTTPS only (Strict-Transport-Security), from the next deploy.
- Desktop: a link that a contact's shared app opens in a new tab now opens in your browser, as links in chats do. The app's own window still never leaves the app.
