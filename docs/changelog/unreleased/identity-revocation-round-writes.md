---
section: Fixed / Identities
---
- The twice-daily lookup of your contacts' proofs for a revocation writes its progress about once a minute instead of after every proof: with 900 contacts' proofs it wrote 45 MB to the device's storage each time, now about 2 MB. A lookup cut short by a crash reads at most its last minute's proofs again.
