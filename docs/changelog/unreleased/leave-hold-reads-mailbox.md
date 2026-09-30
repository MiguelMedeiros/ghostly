---
section: Fixed / Chat
---
- A chat back from "Disconnect for a while" (`chat disconnect --hold`) is live again in seconds, not 30 to 60 s later. If the contact had sent a message during the hold, its app still read yours as DHT only, so it held back your offer and closed your Iroh or HyperDHT dial ("The peer closed this connection") until its next mailbox read. It now reads your mailbox again as soon as you dial, and keeps the dial open meanwhile.
