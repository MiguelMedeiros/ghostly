---
section: Fixed / Wallets
---
- An ecash payment in a chat that the contact has not taken yet no longer asks the mint about it every 10 seconds, nor sends the contact the same token again each time, for as long as the app is open. It is asked about every 10 seconds at first, then less and less often, down to once every 10 minutes, and the token goes again when the chat reconnects.
