---
section: For developers
---
- The engine keeps a list of blocked contacts in the profile's settings (`setContactBlocked`, and `blocked` on a 1:1 chat's view): what a blocked contact's 1:1 chats bring (messages, files by any way they come, reactions, pins, edits, payments, call offers, group invitations, name and picture changes, proofs, shared-app frames) is dropped with nothing shown, stored or rung, its typing, presence and status show nothing, and it is told not to wake the app. The chats keep what they had. The CLI command and the app's Block buttons come next.
