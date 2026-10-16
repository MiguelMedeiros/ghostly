---
section: Fixed / Chat
---
- Every chat picker (Forward, Share to, and which chat to open an app in), open in the web app, the extension or the desktop app, no longer reads every chat's stored messages again each time something changes in the app: during a call or a file transfer that was many times a second. A picker now reads the chats as the chat list does, and parses a chat again only when it changed. The Identities screen's contact names are read the same way, and a contact with two chats is named from the pinned, else the latest, one everywhere, as the chat list already shows them.
