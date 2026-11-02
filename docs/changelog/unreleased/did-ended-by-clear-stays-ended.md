---
section: Fixed / Identities
---
- Clear all data ends your profile's DID for good. Before, when the hourly publish of the DID was still on its way
  (a slow relay, or one waiting for its share of requests), its save put the DID's key and record back after the clear,
  so the cleared profile kept the same DID and its next start published it again over the packet that had ended it.
