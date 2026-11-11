---
section: Fixed / Calls
---
- In the CLI, after the daemon stalls for more than a second during a call, the audio it sends next is stamped with the time that went by. Before, it was stamped as if no time had passed, so the contact's app could take the gap for seconds of network jitter and play the call with more delay for a while.
