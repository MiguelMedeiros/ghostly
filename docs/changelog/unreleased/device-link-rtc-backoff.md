---
section: Fixed / Devices
---
- A device link whose direct connection never connects, on a network that blocks Iroh's relay too, now waits longer
  each time before it tries again without the direct connection, as it was meant to, instead of starting again every
  few seconds for as long as both devices are on.
