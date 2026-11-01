---
section: Fixed / CLI
---
- `chat disconnect --hold` while a call is on in that chat is now refused (`busy`, naming the call): hang it up first. Before, the hold cut the path the call's signals take while its sound went on, so a hang-up from either side never reached the other, whose call ended only 16 s later as `failed`.
