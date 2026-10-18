---
section: Fixed / Wallets
---
- Money in a chat (a Lightning invoice and its QR code, an ecash token, an address, a payment or a request) is drawn again only when the wallets, its payment or the chat's ways of paying change. Before, every card was drawn again on every change in the app, up to 20 times a second while a file moved: with 80 of them in a chat, 23 ms of work each time, now under 1 ms.
