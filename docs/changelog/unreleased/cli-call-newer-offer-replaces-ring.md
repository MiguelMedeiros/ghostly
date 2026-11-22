---
section: Fixed / CLI
release: 1.14
---
- A contact who calls again while their earlier call still rings here (their app closed or reloaded mid-ring, so its hang-up never arrived) now rings as a new call: the ringing one ends as `missed` (`call.ended`), the new one comes as `call.incoming` with its own id, and `call answer` connects it. Before, the new call was ignored and `call answer` picked up the old one, which never connected.
