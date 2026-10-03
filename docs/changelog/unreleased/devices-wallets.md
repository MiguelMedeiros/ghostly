---
section: For developers
---
- Eighth part of "one profile on several devices, one active at a time" (WISP 06): wallets in a move. It is not
  available to people yet: the work is on a branch. A profile with money no longer has to be emptied before it moves.
  Testnet ecash, Spark, Lightning through NWC or Core Lightning, LND without a pinned certificate and the on-chain BDK
  wallet move with the profile and open on the new device once it is the active one; the ecash is checked with its
  mint there once. Ark, Bark, Fedimint, USDT, Bitcoin Core and LND with a pinned certificate stay on the device they
  were made on: the other device shows them as "On <device>" and never opens them, and they open again when the
  profile comes back. Ark and Bark coins that expire in under 3 days keep the profile from moving away from their
  device ("Renew your <wallet> coins first"). Mainnet money in a wallet that moves keeps the profile where it is for
  now: Testnet first. A payment still going through holds the move for up to 30 seconds. The old device deletes the
  Spark wallet's local database once it is on standby, and a wallet that only one device may write to opens only
  after a fresh check of which device is active. A copy that takes over checks its ecash with the mints before it
  counts.
