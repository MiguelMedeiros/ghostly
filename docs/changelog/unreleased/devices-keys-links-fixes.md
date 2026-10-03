---
section: For developers
---
- One profile on several devices (WISP 06), fixes to the device links: a device on standby goes through the person's
  relays, Iroh relays and TURN servers and asks nothing of anyone with the network off (the active device keeps a
  copy of those settings beside the device state); a device signing key that does not sign is never kept, and one
  page never removes a key another page stored; the transports a device link publishes are signed with the device
  signing key, so another holder of the device-set secret cannot stall the link with transports of its own.
