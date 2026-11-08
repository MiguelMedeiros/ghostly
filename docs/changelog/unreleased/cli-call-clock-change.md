---
section: Fixed / Calls
---
- CLI: a call keeps going when the device's clock changes during it (set by hand, or a VM or a phone fixing its time). Before, a clock set back stopped the call's outgoing audio for as long as the jump, a clock set ahead ended the call as `failed`, and `call.ended` gave the jump as the call's `duration` (negative after a clock set back). A clock set back right after a call also no longer refuses `call start` in that chat, or holds the contact's next call as missed, for as long as the jump.
