---
section: Fixed / Relays
---
- The push relay no longer keeps a connection to a push service open after forwarding a push whose answer body the
  push service never finishes sending. It read only the answer's status, and each such forward held one connection and
  file descriptor for as long as the push service kept it open, past the relay's 10 s limit. If you run your own push
  relay, update it from this release.
