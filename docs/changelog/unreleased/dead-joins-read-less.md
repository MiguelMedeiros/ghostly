---
section: Fixed / Chat
---
- A chat you joined whose inviter never comes back (they deleted the chat, their app is gone, or the code was dead) no longer reads the relays at the background pace for as long as the app runs. Ten minutes after the join, it is looked at less often the older it gets, at most every three minutes, the same as an invite nobody used: 15 such chats went from 60 reads a minute to about 10. If the inviter comes back, the chat still connects within three minutes.
