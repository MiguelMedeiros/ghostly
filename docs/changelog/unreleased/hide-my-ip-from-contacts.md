---
section: For users / Everywhere
release: 1.11
---
- Hide my IP from contacts, in Settings, Network: calls, chat connections and group links go through your own TURN server only, so contacts see its address and never yours. It needs a TURN server. If the server does not answer, a call fails with "Your relay did not answer" and a chat waits on the DHT; nothing falls back to a direct connection. While it is on, the Desktop offers contacts no direct Iroh or HyperDHT connection (the chat's Connection menu says Hide my IP is why), contacts' public profiles load no pictures from servers they chose, a contact's shared web app loads pictures, scripts and frames from its own server only (the browser extension does not open one, and says why), and calls in the Linux app are off.
