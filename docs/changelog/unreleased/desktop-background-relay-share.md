---
section: Fixed / Desktop
---
- On a network where the DHT can't be reached (UDP blocked, some VPNs), chats that are waiting in the background can no longer use up a discovery relay's requests for the minute. They now get at most two thirds of it, and the rest stays for the chat you have open. Before, a contact's offer or answer could go unread for up to a minute, until the relay's minute freed up.
