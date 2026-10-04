---
section: Fixed / Devices
---
- A web page and a Linux Desktop on the same profile connect over HyperDHT as well as Iroh. The link between your devices offered HyperDHT only when the page's HyperDHT relay answered at the first try, never on a page on standby, and never after a relay set later; when the page's Iroh relay was out of the Desktop's reach the two could not connect at all. A connection that does not start is now tried again in a while.
