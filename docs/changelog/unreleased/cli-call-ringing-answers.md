---
section: Fixed / CLI
---
- `ghostly call start <chat>` while the contact's call rings here now says so and names the next step (`ghostly call answer <chat>`), with the ringing call's id in the details. It said only that a call was already on. `call answer` on a call you placed says it is yours and rings at the contact's, not that it is not ringing while `call list` read `ringing`. `call hangup` answers `audio: null` and no stats: it gave the socket it had just removed, its token and the closed connection's stats.
