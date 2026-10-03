---
section: For developers
---
- Fifth part of "one profile on several devices, one active at a time" (WISP 06): the handoff, which moves a profile
  from the active device to another one. It is not available to people yet: the work is on a branch. On a standby,
  "Use here" asks for the profile's lock password, which the active device checks with a password proof (OPAQUE,
  through `opaque-ke` compiled to WebAssembly) without ever seeing it; five wrong tries in an hour lock
  that device out for an hour, and fifteen refuse it until the person lets it try again on the active device. On the
  active device, "Move to <device>" offers the profile to a device that is on, and the person says "Use here" there.
  Files are copied first while the active device stays in use, skipped when the other device already has them, and
  sealed piece by piece; on mobile data files over 16 MB can stay behind. Then the active device stops without a word
  to its contacts, sends the rest in the backup format of WISP 05, and goes on standby only once the other device
  checked everything. The new device writes all of it into a storage space of its own, points the profile at it in
  one step, takes the turn and waits about 30 seconds to be sure no other device took it at the same moment, and then
  reaches the contacts the way an app that restarted does. A crash at any step leaves the profile active on one of
  the two devices. Until wallets move (part 8), a profile that holds money, or has a payment open, is not moved.
