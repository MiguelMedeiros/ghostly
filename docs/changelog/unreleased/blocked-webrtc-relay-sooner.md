---
section: Fixed / Chat
---
- On a network that blocks direct connections (a VPN, a firewall), a saved chat took 20 to 50 seconds to come back, and minutes in apps whose WebRTC never reports a failure, before it went through a relay. It now takes about 7 to 10 seconds: an answered WebRTC attempt that has not connected after 6 seconds is raced by the relayed transport, and an app whose WebRTC cannot even start dials the relayed transport itself at once.
