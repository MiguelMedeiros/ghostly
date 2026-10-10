---
section: Fixed / Calls
---
- Ghostly Desktop on Linux draws its first screen without waiting for the call engine (GStreamer) to start and check its plugins, which took about 0.6 s more on a first launch or the first after a GStreamer update.
