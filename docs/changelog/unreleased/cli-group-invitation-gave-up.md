---
section: Fixed / CLI
---
- `ghostly group list` and `group show` say when a join through a group's link stopped knocking because nobody answered for an hour (`unanswered: true`; `group accept` knocks again), and when the contact who invited you took the invitation back (`takenBack: true`). Both read as a live invitation before, and the daemon's log now says the join gave up too.
