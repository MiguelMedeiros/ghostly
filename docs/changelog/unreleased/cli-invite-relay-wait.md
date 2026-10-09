---
section: For developers / CLI
---
- `invite create` on a daemon answers at once when the relays' request budget holds the new invite back (a few invites
  in a minute), with `"published": false` and `retryInMs`, instead of waiting 20 s and returning a link that was not out
  yet without a word. A published invite says `"published": true`.
