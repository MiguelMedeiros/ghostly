---
section: Fixed / CLI
---
- A change to which identities your public DID lists, made without a daemon (`engine setDidListed`, or `identity remove` of a listed proof), is published before the command ends: it ended first, so the DID kept the old list, a removed identity in it, until a daemon ran on that profile for 15 seconds.
