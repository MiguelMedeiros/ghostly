---
section: For developers
---
- Second part of "one profile on several devices, one active at a time" (WISP 06): the turn record, which says which
  of a person's devices is the active one. Its fixed binary format, with test vectors shared by TypeScript and the
  Desktop's Rust; its own read (every relay is asked, and on Desktop the DHT itself) and its own conditional put (a
  refusal is never sent again without its condition); the result of a read, clone detection included; what each
  device state does on each result; and limited mode in the engine (nothing published, dialled or settled in hold
  storage, no wallet opened, until the turn was read). Nothing uses it yet: no profile has a second device, and a
  profile on one device makes no turn read or put.
