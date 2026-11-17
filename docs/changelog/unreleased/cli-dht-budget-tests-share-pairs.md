---
section: For developers / Tests
---
- The CLI's DHT packet-budget tests share their pairs: `dhtEditPacketBudget` and `dhtBudgetWords` are folded into `dhtPacketBudget` (one alice/bob pair for this side's, both sides' and the contact's DHT only) and `dhtOnlyLongText` (one carol/dave pair and one 30 s hold for the long text, the too-long text and the edit). Four files of about 190 s of test time are two of about 125 s.
