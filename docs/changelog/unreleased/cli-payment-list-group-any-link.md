---
section: Fixed / CLI
release: 1.14
---
- `payment list` names a group's payment's `group` whichever member's link it went over, as the `payment.created` and `payment.updated` events already did: a member paying my group request over their link, a member's request that came to me, and a community payment. Only a request to the whole group carried it, so a bot catching up from the list after a restart saw those with only `chat`, an id `chat show` does not know.
