---
section: For developers
---
- Sixth part of "one profile on several devices, one active at a time" (WISP 06): the forced takeover and the guard on
  restoring a backup. On a device on standby that holds a copy of the profile, "My other device is lost or broken"
  takes over when the active device cannot be reached: it asks for the profile's lock password (five wrong tries in an
  hour lock the device out for an hour, fifteen for good, and a wrong one changes nothing) and the name of the device
  that stops, waits about 30 seconds to be sure no other device took over at the same moment, and starts. A device
  that was replaced reads that before its engine starts when it comes back, stops without a word to its contacts, and
  offers "It wasn't me". A copy started from older state (a takeover, or any restored backup) sends above every number
  the copy it replaced may have used, so its first messages in a group or a community are no longer dropped by the
  other members as already seen; it signs no group change and takes no door duty until the person turns on "Manage
  groups from this device" in that group; a payment it finds signed but unfinished is never sent again; and the
  on-chain wallet scans again. A backup of a profile on several devices carries its device set in a newer backup
  format, and restoring one where the profile is active on another device does not start it: the app offers to add the
  device instead, to take over, or to cancel. After any restore, as after a takeover, the copy signs no group change
  and takes no community door duty until "Manage groups from this device" is turned on in that group.
