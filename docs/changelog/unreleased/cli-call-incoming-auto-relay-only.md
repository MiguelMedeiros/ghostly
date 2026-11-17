---
section: Fixed / CLI
release: 1.14
---
- With Hide my IP from contacts on, `call.incoming` now says `auto: false` and the daemon no longer tries to auto-answer, since the CLI answers no call in that mode. Before, the event said `auto: true` while the answer failed and the call kept ringing, so a program trusting `auto` neither answered nor declined it.
