---
section: For developers / CLI
---
- Calls: a headless call no longer runs its Opus encoder on every silent frame. Once silence has encoded to the same packet for half a second, that packet is sent again every 20 ms until the program's audio is back, so the contact receives what it did before. A call where the program only listens used 5.0% of a core at 48 kHz and 4.0% at 16 kHz, and now uses 3.9% and 2.4%.
