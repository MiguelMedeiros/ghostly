---
section: Fixed
---
- One profile on several devices (WISP 06): a group change (adding, removing, a new admin, a new key or link) and
  answering knocks at a community's door now need a recent check that this device is the active one. When the check
  is old, Ghostly checks again first; when it cannot, the group is not changed and the app says why, so two devices
  that both think they are active can never split a group.
