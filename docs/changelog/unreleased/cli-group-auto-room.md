---
section: For developers / CLI
release: 1.11
---
- With `ghostly group auto on --from <chat>`, an invitation over a chat on the list is no longer kept out when 32 invitations already wait: it takes the place of the oldest waiting one from the chat that holds the most. Other contacts' invitations, which nobody answers on a bot, could otherwise fill the list for good. Without `group auto`, nothing changes.
