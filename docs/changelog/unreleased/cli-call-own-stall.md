---
section: Fixed / Calls
---
- CLI: a call stays on when the daemon itself stops for a while (its machine busy or swapping, the process paused). Before, the time it stood still was read as the contact's silence: past 5 s it said `call.stalled`, and past 15 s it ended the call as `failed` and hung up on the contact, whose audio had been waiting to be read all along.
