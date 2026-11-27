---
section: Fixed / CLI
---
- `ghostly listen`: a contact's identity proof that a newer proof of the same identity replaced now gets its `identity.status` `withdrawn`, as the chat's own timeline and the contact's side say. Before, it left without an event, so a script or an agent that follows proofs by id kept it as verified for good.
