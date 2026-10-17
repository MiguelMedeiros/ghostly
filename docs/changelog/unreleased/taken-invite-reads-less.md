---
section: Fixed / Chat
---
- A chat whose invite someone else used first ("This invite was already used") no longer reads its inviter every few seconds each time the inviter's app checks in. While the inviter was online, such a chat spent about 16 relay requests a minute for as long as the app ran; it now looks now and then, less often the older it gets, and still notices if the invite was not taken after all. This holds after a restart too, and for a chat that had already found its inviter before it learned the invite was taken, which also stops calling that inviter.
