---
section: Fixed / Chat
---
- A chat with a transport chosen (HyperDHT, for instance) is live again within seconds when both apps restart together. The chosen transport is dialled first; when the contact's endpoint was still starting, it failed once and was not tried again until the WebRTC offer timed out, 30 to 110 seconds later. Now it races the unanswered offer once more after 8 seconds.
