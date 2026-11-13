---
section: Fixed / Chat
---
- A chat whose contact's app crashed and came back reconnects over WebRTC even when the old HyperDHT or Iroh connection times out just as the new one is being made. Before, that timeout also cut off the new connection, and the chat stayed apart for about 90 seconds more.
