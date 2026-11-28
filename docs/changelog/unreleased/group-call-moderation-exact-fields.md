---
section: For developers
---
- `verifyGroupCallModeration` in `@ghostly/core` (and the e2e SFU token double) refuses a moderation request carrying `name` or any field WISP 602 § Moderation does not list, as the occupancy check already did. Every released app sends exactly those fields, so their requests still pass.
