---
section: Security / Desktop
---
- The desktop app's QUIC stack (quinn-udp, under Iroh) moves to 0.5.16 and 0.6.3 (RUSTSEC-2026-0538): a truncated datagram from the network could leave the receive loop spinning.
