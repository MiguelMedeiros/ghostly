---
section: Fixed / Everywhere
---
- The web app, extension and CLI ask the Iroh relays how near they are once per app instead of once per chat: with 16 chats listening, the relays get about a quarter of the requests they got (25 a minute instead of 103), and the relays a chat is not on get almost none.
