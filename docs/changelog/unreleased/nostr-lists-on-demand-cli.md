---
section: For developers / CLI
---
- New engine calls `nostrOwnFollows { subject }` and `nostrContactNotes { linkId, subject }` read your own Nostr
  follow list and a contact's loaded posts. The engine state now gives `nostr.own[].follows.count` instead of the
  `follows` list, and a chat's `nostr[].notes.count` instead of the `notes` list.
