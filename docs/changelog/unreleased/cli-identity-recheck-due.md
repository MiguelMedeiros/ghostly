---
section: Fixed / CLI
release: 1.11
---
- `identity contact` and `identity recheck` mark a contact's proof `recheckDue` only when the app itself would check it again now: a verified or unconfirmed proof under the contact's current key, a day after its last check. It said a check was due for withdrawn, revoked and expired proofs, which are never checked again, and 10 minutes after a GitHub or GitLab key's check, which the app repeats only after a day.
