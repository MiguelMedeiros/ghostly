---
section: For developers / CLI
---
- `GHOSTLY_IROH_RELAYS=https://…,…` pins the CLI's Iroh relays, as `GHOSTLY_PKARR_RELAYS` pins its Pkarr relays, and `GHOSTLY_STUN=0` leaves the apps' public STUN servers out of its WebRTC, so a private network reaches nothing public. The CLI's tests and the web e2e's headless bots now stay on this machine by default (local or dead relays, loopback HyperDHT, no public STUN); `GHOSTLY_TEST_PUBLIC_NET=1` lets a run reach the public networks.
