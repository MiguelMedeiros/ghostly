---
section: Fixed / Everywhere
---
- HyperDHT costs the network far less on the Desktop and the CLI: all chats now share one HyperDHT node, and a chat that is live over HyperDHT no longer keeps its listener announced, which cost about 62 requests a minute per chat. With eight live chats, a lab measured about 10 HyperDHT requests a minute instead of about 1,050. A contact whose app was killed or lost its network may now take up to about a minute to reconnect, as long as this side takes to notice.
