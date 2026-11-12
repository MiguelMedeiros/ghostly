---
section: Fixed / Everywhere
---
- A contact you share a service with can no longer make your Ghostly hold more than 128 MiB of their request bodies at once by opening many uploads and never finishing them. Past that, a new upload gets the usual "busy" answer, and an upload's body is no longer kept twice while your service reads it.
