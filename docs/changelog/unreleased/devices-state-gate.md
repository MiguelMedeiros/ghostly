---
section: For developers
---
- First part of "one profile on several devices, one active at a time" (WISP 06). The app now reads a device state
  before it starts a profile: a profile used on one device only runs exactly as before; a device that is not the
  active one for a profile opens none of its data, starts no wallet and publishes nothing, and shows a standby screen
  instead. Nothing can add a second device yet, so no profile is on standby today.
- The profile database moves to version 12. An older Ghostly that is given this storage says "This profile was last
  used by a newer version of Ghostly." and starts nothing.
