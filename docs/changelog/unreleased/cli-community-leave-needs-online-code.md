---
section: Fixed / CLI
release: 1.14
---
- `ghostly group leave` of a community nobody is connected to, and an admin's `ghostly group forget` of one, now answer with code `unavailable` instead of `engine`: a state that changes once a member is connected, as a contact who is not connected is. The exit code stays 1.
