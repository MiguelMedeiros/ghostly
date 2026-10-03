---
section: For developers
---
- Fourth part of "one profile on several devices, one active at a time" (WISP 06): adding a device. It is not
  available to people yet: the work is on a branch, and a device that is added cannot become the active one until
  the handoff (part 5) is built. On the active device, Profile, Devices, "Add a device" asks for a lock password of 8
  characters or more (set, typed again, or made longer; a profile that never adds a device keeps its 4-character
  lock), then shows a code good for 10 minutes. The code is a new invite version (2), which the chat reader refuses
  as a device code and Ghostly 1.0.2 refuses as a newer version (test vectors included). On the new device, "I already
  use Ghostly" on a new profile reads the code. The two meet on a one-time paired session (`enroll/1`) signed with
  their device signing keys: the code admits one device only, the active device proves itself first, and only then
  both show the same six digits. Once the person confirms on the active device, the new device stores the device set
  as a standby and the active device publishes its turn record with it; a crash at any step leaves no device added or
  a complete one. The new device ends on the standby screen with a live link to the active device. In an iPhone or iPad
  browser tab it says to add Ghostly to the Home Screen first; elsewhere it asks the browser to keep its storage and
  warns when it does not.
