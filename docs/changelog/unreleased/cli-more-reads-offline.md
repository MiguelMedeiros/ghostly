---
section: Fixed / CLI
---
- `call list`, `call auto` (with no on or off), `app served`, `identity providers`, `identity contact`, `service peer` and `profile backup` with no daemon running now read the profile offline too, as `status` does, in a fraction of a second and with nothing sent to the Pkarr relays. Each took 3 seconds with a slow relay. A `profile backup` with no passphrase given now says so before it opens the profile.
