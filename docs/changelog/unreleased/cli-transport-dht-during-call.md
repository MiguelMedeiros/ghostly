---
section: Fixed / CLI
---
- `chat transport <chat> dht` while a call is on in that chat is now refused (`busy`, naming the call), as a hold is: hang it up first. Before, the switch cut the path the call's signals take while its sound went on, so a hang-up from either side never reached the other, whose call ended only 16 s later as `failed`.
