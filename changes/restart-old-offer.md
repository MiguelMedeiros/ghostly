---
section: Fixed / Everywhere
---
- An app back after a restart no longer answers a contact's old offer that one relay still served, and dials the contact instead. Before, a chat or a group's edge could wait about half a minute on that dead offer before its own went out. A relay that missed a packet because it was busy now gets it when it frees up.
