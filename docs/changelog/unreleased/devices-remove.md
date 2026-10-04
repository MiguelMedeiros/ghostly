---
section: For developers
---
- Seventh part of "one profile on several devices, one active at a time" (WISP 06): removing a device. On the active
  device, Profile, Devices, Remove takes a device out of the profile: the devices move to a new device secret, which
  the removed device never gets, so it can no longer take the profile and reaches none of the others. The other
  devices get the new secret over their old connection the next time they are open together, even a device that was
  closed at the time, and show the new list of devices once, with "This is wrong" if it looks wrong. A device that was
  removed shows so when it opens, and can be added again. A device that was off while the person's devices changed in
  a way it cannot check asks to be added again. "New device secret" does the same with nobody removed: Ghostly makes
  one by itself when a device was being added and never finished, and offers one after a takeover. "Lost or stolen"
  lists what to do next: change the storage keys, move the money out of each wallet the lost device could spend from,
  and pair each chat again. A crash at any step of a removal picks up where it stopped. Going online as the active
  device now holds every action until it has checked that it is still the active one.
