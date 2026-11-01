---
section: Fixed / CLI
---
- `chat remove <chat> --yes` while a call is on in that chat is now refused (`busy`, naming the call), as a hold is: hang it up first. Before, the chat was deleted and its call talked on, sound both ways, in a chat `chat show` no longer found; a hang-up then reached nobody, and the contact's call ended only when its sound stopped coming.
